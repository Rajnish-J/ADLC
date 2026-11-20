// The live "agent map" of a workflow run: the orchestrator, each step it handed out (with the agent, harness, time,
// tokens, tool calls, files and what it is doing right now), the subagents a harness spawned inside a step, and where
// the run is in the workflow. Built from the run's steps and activity events — the same data on the web (run monitor
// dock) and in VS Code (Run monitor view). Pure, and typed structurally so both clients can feed it their contracts.

export type RunMapStatus = 'pending' | 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped'

export interface RunMapStepInput {
  stepId: string
  nodeId: string | null
  seq: number
  kind: string
  label: string
  status: string
  startedAt: string | null
  finishedAt: string | null
  agentName: string | null
  engine?: string | null
  tokensIn: number | null
  tokensOut: number | null
  toolCalls: number | null
  changedFiles: readonly string[]
}

export interface RunMapEventInput {
  seq: number
  at: string
  type: string
  stepId: string | null
  agentType: string | null
  agentName: string | null
  skill?: string | null
  tool: string | null
  path: string | null
  summary: string | null
  data: Record<string, unknown>
}

export interface RunMapRunInput {
  status: string
  startedAt: string
  finishedAt: string | null
  workflowName: string
  engine?: string | null
  pendingApproval: { stepId: string; question: string; kind?: string } | null
  tokensIn: number
  tokensOut: number
}

export interface RunMapSpecNode {
  id: string
  kind: string
  label: string
}

export interface RunMapSubAgent {
  name: string
  status: 'running' | 'done'
  startedAt: number
  elapsedMs: number
}

export interface RunMapNode {
  stepId: string
  nodeId: string | null
  kind: string
  label: string
  agentName: string | null
  harness: string | null
  status: RunMapStatus
  startedAt: number | null
  elapsedMs: number
  /** Null when the harness doesn't report its usage. */
  tokens: number | null
  toolCalls: number
  files: number
  skills: string[]
  /** What the step did last ("Edit src/app.ts", "Plan submitted"). */
  lastActivity: string | null
  subAgents: RunMapSubAgent[]
}

export interface RunMapFlowNode {
  nodeId: string
  label: string
  kind: string
  state: RunMapStatus
}

export interface RunMap {
  orchestrator: {
    label: string
    status: RunMapStatus
    elapsedMs: number
    tokens: number | null
    /** What the run is doing now: the newest activity, or what it waits on. */
    activity: string | null
    /** Waiting in VS Code behind another run (one run per workspace). */
    queuedBehind: string | null
  }
  nodes: RunMapNode[]
  /** Every workflow node, in order, with how far the run got (when the spec is known). */
  flow: RunMapFlowNode[]
  currentNodeId: string | null
}

const ENDED = new Set(['completed', 'failed', 'cancelled', 'expired'])

export function runStatusOf(status: string): RunMapStatus {
  switch (status) {
    case 'requested':
      return 'pending'
    case 'queued':
      return 'queued'
    case 'awaiting_approval':
      return 'waiting'
    case 'completed':
      return 'done'
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'failed'
    default:
      return 'running'
  }
}

function stepStatusOf(status: string, waiting: boolean): RunMapStatus {
  if (status === 'running') return waiting ? 'waiting' : 'running'
  if (status === 'succeeded') return 'done'
  if (status === 'skipped') return 'skipped'
  return 'failed' // failed, blocked
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** One activity event as a short line ("Edit src/app.ts", "Bash npm test", "Plan submitted"). */
export function describeEvent(e: RunMapEventInput): string | null {
  switch (e.type) {
    case 'tool.called':
    case 'tool.failed': {
      const what = e.path ?? e.summary
      const name = e.tool ?? 'Tool'
      return `${e.type === 'tool.failed' ? '✕ ' : ''}${what ? `${name} ${what}` : name}`
    }
    case 'file.changed':
      return e.path ? `Changed ${e.path}` : 'Changed a file'
    case 'skill.used':
      return e.skill ? `Using skill ${e.skill}` : 'Using a skill'
    case 'agent.started':
      return `Started ${e.agentName ?? e.agentType ?? 'a subagent'}${e.summary ? `: ${e.summary}` : ''}`
    case 'agent.stopped':
      return `${e.agentName ?? e.agentType ?? 'Subagent'} finished`
    case 'plan.submitted':
      return 'Plan submitted — waiting for approval'
    case 'approval.requested':
      return e.summary ?? 'Waiting for approval'
    case 'approval.decided':
      return e.summary ?? 'Decision recorded'
    case 'step.started':
      return `${e.agentName ?? e.summary ?? 'Step'} started`
    case 'step.completed':
      return 'Step completed'
    case 'gate.evaluated':
      return e.summary ?? 'Quality gate evaluated'
    case 'memory.read':
      return 'Read project memory'
    case 'memory.written':
      return e.summary ? `Saved memory: ${e.summary}` : 'Saved memory'
    case 'usage':
      return null
    default:
      return e.summary
  }
}

export function buildRunMap(
  run: RunMapRunInput,
  steps: readonly RunMapStepInput[],
  events: readonly RunMapEventInput[],
  spec: readonly RunMapSpecNode[] | null = null,
  now = Date.now(),
): RunMap {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const runEnd = run.finishedAt ? Date.parse(run.finishedAt) : now
  const byStep = new Map<string, RunMapEventInput[]>()
  for (const e of sorted) {
    if (!e.stepId) continue
    const list = byStep.get(e.stepId) ?? []
    list.push(e)
    byStep.set(e.stepId, list)
  }
  const pendingStep = run.status === 'awaiting_approval' ? (run.pendingApproval?.stepId ?? null) : null

  const nodes: RunMapNode[] = [...steps]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => {
      const evs = byStep.get(s.stepId) ?? []
      const start = s.startedAt ? Date.parse(s.startedAt) : null
      const end = s.finishedAt ? Date.parse(s.finishedAt) : runEnd
      const usage = evs.filter((e) => e.type === 'usage').reduce((n, e) => n + num(e.data.tokensIn) + num(e.data.tokensOut), 0)
      const recorded = (s.tokensIn ?? 0) + (s.tokensOut ?? 0)
      const tools = evs.filter((e) => e.type === 'tool.called' || e.type === 'tool.failed').length
      const files = new Set([...s.changedFiles, ...evs.filter((e) => e.type === 'file.changed' && e.path).map((e) => e.path as string)])
      const skills = [...new Set(evs.filter((e) => e.type === 'skill.used' && e.skill).map((e) => e.skill as string))]
      const subAgents: RunMapSubAgent[] = []
      for (const e of evs) {
        const at = Date.parse(e.at)
        if (e.type === 'agent.started') {
          subAgents.push({ name: e.agentName ?? e.agentType ?? 'Subagent', status: 'running', startedAt: at, elapsedMs: 0 })
        } else if (e.type === 'agent.stopped') {
          const name = e.agentName ?? e.agentType
          const open = subAgents.find((a) => a.status === 'running' && (!name || a.name === name)) ?? subAgents.find((a) => a.status === 'running')
          if (open) {
            open.status = 'done'
            open.elapsedMs = Math.max(0, at - open.startedAt)
          }
        }
      }
      const status = stepStatusOf(s.status, pendingStep === s.stepId)
      for (const a of subAgents) {
        if (a.status === 'running') {
          if (status === 'running' || status === 'waiting') a.elapsedMs = Math.max(0, now - a.startedAt)
          else a.status = 'done'
        }
      }
      const last = [...evs].reverse().map(describeEvent).find((d): d is string => !!d) ?? null
      return {
        stepId: s.stepId,
        nodeId: s.nodeId,
        kind: s.kind,
        label: s.label,
        agentName: s.agentName,
        harness: s.engine ?? null,
        status,
        startedAt: start,
        elapsedMs: start === null ? 0 : Math.max(0, (s.status === 'running' ? runEnd : end) - start),
        tokens: Math.max(usage, recorded) > 0 ? Math.max(usage, recorded) : null,
        toolCalls: Math.max(tools, s.toolCalls ?? 0),
        files: files.size,
        skills,
        lastActivity: status === 'waiting' ? (run.pendingApproval?.question ?? 'Waiting for approval') : last,
        subAgents,
      }
    })

  // Queued in VS Code: the newest queue nudge says so, unless the run has started working since.
  let queuedBehind: string | null = null
  for (const e of sorted) {
    if (e.type === 'nudge' && e.data.queued === true) queuedBehind = typeof e.data.behind === 'string' ? e.data.behind : 'another run'
    else if ((e.type === 'nudge' && e.data.queued === false) || e.type === 'session.started' || e.type === 'harness.opened') queuedBehind = null
  }
  if (ENDED.has(run.status)) queuedBehind = null

  let status = runStatusOf(run.status)
  if (queuedBehind && status !== 'waiting') status = 'queued'
  const running = [...nodes].reverse().find((n) => n.status === 'running' || n.status === 'waiting')
  const recordedTotal = run.tokensIn + run.tokensOut
  const nodeTotal = nodes.reduce((n, x) => n + (x.tokens ?? 0), 0)
  const total = Math.max(recordedTotal, nodeTotal)
  const lastEvent = [...sorted].reverse().map(describeEvent).find((d): d is string => !!d) ?? null
  const activity =
    status === 'waiting'
      ? (run.pendingApproval?.question ?? 'Waiting for approval')
      : status === 'queued'
        ? `Queued in VS Code behind ${queuedBehind}`
        : status === 'pending'
          ? 'Waiting for VS Code to pick up the run'
          : (running?.lastActivity ?? lastEvent)

  const flow: RunMapFlowNode[] = (spec ?? []).map((n) => {
    const latest = [...nodes].reverse().find((x) => x.nodeId === n.id)
    let state: RunMapStatus = latest ? latest.status : 'pending'
    if (n.kind === 'trigger') state = 'done'
    if (n.kind === 'end') state = run.status === 'completed' ? 'done' : 'pending'
    return { nodeId: n.id, label: n.label, kind: n.kind, state }
  })

  return {
    orchestrator: {
      label: run.workflowName,
      status,
      elapsedMs: Math.max(0, runEnd - Date.parse(run.startedAt)),
      tokens: total > 0 ? total : null,
      activity,
      queuedBehind,
    },
    nodes,
    flow,
    currentNodeId: running?.nodeId ?? null,
  }
}

/** The workflow steps people count ("Step 2 of 6"): the ones that do work or wait on someone. */
const COUNTED_KINDS = new Set(['agent', 'gate', 'approval'])

export interface RunProgress {
  /** 1-based position of the current step; with no current step, how many steps are done. */
  index: number
  /** Counted steps in the workflow (0 when the spec is unknown). */
  total: number
  /** The current step's label, else the run's activity. */
  label: string | null
  state: RunMapStatus
}

/** Where a run is, as "Step N of M" — shared by the run page's flow card and the minimized run pill. */
export function runProgress(map: RunMap): RunProgress {
  const steps = map.flow.filter((n) => COUNTED_KINDS.has(n.kind))
  const at = map.currentNodeId ? steps.findIndex((n) => n.nodeId === map.currentNodeId) : -1
  const current = at >= 0 ? steps[at] : null
  const done = steps.filter((n) => n.state === 'done' || n.state === 'skipped').length
  return {
    index: current ? at + 1 : done,
    total: steps.length,
    label: current?.label ?? map.nodes.find((n) => n.nodeId === map.currentNodeId)?.label ?? null,
    state: current?.state ?? map.orchestrator.status,
  }
}

/** `42s`, `4m 52s`, `1h 03m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** `950`, `12.4k`, `1.2M` tokens. */
export function formatTokens(n: number | null): string {
  if (n === null) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
