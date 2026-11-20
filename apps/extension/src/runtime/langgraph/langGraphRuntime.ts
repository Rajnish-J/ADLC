// Phase 4 — LangGraphWorkflowRuntime: a second WorkflowRuntime implementation, this one backed by a real
// @langchain/langgraph StateGraph (compiled per run by specToStateGraph.ts) instead of the hand-rolled FIFO
// interpreter in mock/mockRuntime.ts. Mandatory two-phase (plan -> approve -> execute) HITL is expressed via
// LangGraph's `interrupt()` + `Command({ resume })`, and durably checkpointed (see checkpointSaver.ts) so a
// paused run survives an extension-host restart — recompiling the graph from persisted run metadata
// (runMetaStore.ts) when it isn't already held in the in-process cache.
//
// RunState/RunStep/ApprovalDecision are unchanged — RunService, the webview, and the chat participant don't
// need to know which runtime produced them.
//
// Lifecycle notes:
//   • Progress is STREAMED (`graph.stream`, modes `updates` + `tasks`): every finished node's step lands in the
//     RunState mirror as it completes, and a provisional `running` step is shown the moment a node starts —
//     so the canvas animates through the plan phase instead of jumping from one approval pause to the next.
//   • Cancel is real: it aborts the in-flight stream via a per-run AbortController (also handed to the
//     dispatcher/gate through the node closures), and — like completion/failure — retires the run.
//   • A run is RETIRED when it reaches a terminal state: its checkpoint thread and run metadata are deleted.
//     Terminal runs never need restoring (RunService + the audit store already hold their history), and this
//     is what keeps the two JSON files bounded and stops a cancelled run resurrecting after a reload.

import { Command } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { BudgetExceededError } from '../guards'
import { RUN_FAILURE_KEY, stepIdFor } from './nodeHelpers'
import { mergeStepsById } from './state'
import { compileStateGraph, type InterruptPayload } from './specToStateGraph'
import type { RunMeta } from './runMeta'
import type {
  AgentDispatcher,
  ApprovalDecision,
  GateEvaluator,
  PendingApproval,
  RunState,
  RunStep,
  StartRunArgs,
  Unsubscribe,
  WorkflowRuntime,
  FragmentSource,
} from '../port'
import type { RunBudget, SpecNodeKind, WorkflowSpec } from '../spec'

/** A paused run older than this is discarded at restore time rather than resurrected. */
export const PAUSED_RUN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** The subset of RunMetaStore's API the runtime needs — lets tests inject a plain in-memory Map instead of
 * the real vscode.workspace.fs-backed store. */
export interface RunMetaPort {
  save(runId: string, meta: RunMeta): Promise<void>
  get(runId: string): Promise<RunMeta | undefined>
  delete(runId: string): Promise<void>
  list(): Promise<Array<{ runId: string; meta: RunMeta }>>
}

export class InMemoryRunMetaPort implements RunMetaPort {
  private readonly map = new Map<string, RunMeta>()
  async save(runId: string, meta: RunMeta): Promise<void> {
    this.map.set(runId, meta)
  }
  async get(runId: string): Promise<RunMeta | undefined> {
    return this.map.get(runId)
  }
  async delete(runId: string): Promise<void> {
    this.map.delete(runId)
  }
  async list(): Promise<Array<{ runId: string; meta: RunMeta }>> {
    return [...this.map.entries()].map(([runId, meta]) => ({ runId, meta }))
  }
}

export interface LangGraphRuntimeDeps {
  dispatcher: AgentDispatcher
  gate: GateEvaluator
  checkpointer: BaseCheckpointSaver
  runMeta: RunMetaPort
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number
  /** Counter seed for deterministic run ids in tests. */
  idSeed?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompiledGraph = any

interface NodeInfo {
  kind: SpecNodeKind
  label: string
}


interface RunEntry {
  state: RunState
  graphApp: CompiledGraph
  /** Aborted by cancelRun; its signal is also what the node closures hand to the dispatcher and the gate. */
  abort: AbortController
  /** Spec node id -> kind/label, to name a node's provisional `running` step the moment its task starts. */
  nodes: Map<string, NodeInfo>
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const isTerminal = (status: string): boolean => TERMINAL.has(status)

function pendingApprovalFromPayload(payload: InterruptPayload): PendingApproval {
  return {
    stepId: payload.stepId ?? '',
    nodeId: payload.nodeId,
    question: payload.kind === 'agent-plan' ? `Approve plan for "${payload.agentName}"?` : payload.question ?? 'Approve to continue?',
    default: payload.default,
    plan: payload.plan,
  }
}

function nodeInfoFor(spec: WorkflowSpec): Map<string, NodeInfo> {
  return new Map(spec.nodes.map((n) => [n.id, { kind: n.kind, label: n.label }]))
}

/**
 * Which spec node a LangGraph task belongs to, if its start should show as a NEW running step. Only the
 * sub-node that opens a step qualifies (`<id>__plan`, `<id>__begin`, or a plain gate/set-variable/goto node);
 * `__approve`/`__wait`/`__execute` continue a step that is already on screen.
 */
function provisionalFor(taskName: string, nodes: Map<string, NodeInfo>): { nodeId: string; kind: SpecNodeKind; label: string } | undefined {
  const opens = (suffix: string, kind: SpecNodeKind): { nodeId: string; kind: SpecNodeKind; label: string } | undefined => {
    if (!taskName.endsWith(suffix)) return undefined
    const nodeId = taskName.slice(0, -suffix.length)
    const info = nodes.get(nodeId)
    return info ? { nodeId, kind, label: info.label } : undefined
  }
  const viaSuffix = opens('__plan', 'agent') ?? opens('__begin', 'approval')
  if (viaSuffix) return viaSuffix
  const info = nodes.get(taskName)
  if (info && (info.kind === 'gate' || info.kind === 'set-variable' || info.kind === 'goto')) {
    return { nodeId: taskName, kind: info.kind, label: info.label }
  }
  return undefined
}

export class LangGraphWorkflowRuntime implements WorkflowRuntime {
  private readonly runs = new Map<string, RunEntry>()
  private readonly listeners = new Set<(state: RunState) => void>()
  private readonly now: () => number
  private idCounter: number

  constructor(private readonly deps: LangGraphRuntimeDeps) {
    this.now = deps.now ?? Date.now
    this.idCounter = deps.idSeed ?? 0
  }

  onRunUpdate(listener: (state: RunState) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(state: RunState): void {
    for (const l of this.listeners) l(structuredClone(state))
  }

  private config(runId: string): { configurable: { thread_id: string } } {
    return { configurable: { thread_id: runId } }
  }

  /** Compiles the run's StateGraph and wraps it with the per-run abort controller and node lookup. */
  private buildEntry(runId: string, spec: WorkflowSpec, budget: RunBudget, state: RunState): RunEntry {
    const abort = new AbortController()
    const graphApp = compileStateGraph(
      spec,
      runId,
      budget,
      { dispatcher: this.deps.dispatcher, gate: this.deps.gate, now: this.now, signal: abort.signal },
      this.deps.checkpointer,
    )
    return { state, graphApp, abort, nodes: nodeInfoFor(spec) }
  }

  async startRun(args: StartRunArgs): Promise<RunState> {
    const startedAt = this.now()
    // Unique across extension-host sessions: a restored paused run keeps its id and checkpoint thread, so a
    // plain per-session counter (lg-run-1 again after a reload) would collide with it.
    const runId = args.runId ?? `lg-run-${startedAt.toString(36)}-${++this.idCounter}`
    if (args.runId && (this.runs.has(runId) || (await this.deps.runMeta.get(runId)))) {
      throw new Error(`Run id already in use: ${runId}`)
    }
    const budget: RunBudget = args.budget ?? args.spec.budget

    const inputs = args.inputs ?? {}
    const seed = String(inputs.task ?? inputs.message ?? inputs.prompt ?? '')
    const vars: Record<string, unknown> = { ...inputs, 'System.LastMessage.Text': seed, 'Local.WorkItem': seed }
    if (inputs.workItemId !== undefined) vars['Local.WorkItemId'] = inputs.workItemId
    if (inputs.workItemUrl !== undefined) vars['Local.WorkItemUrl'] = inputs.workItemUrl

    const state: RunState = {
      runId,
      workflowName: args.spec.name,
      status: 'running',
      actor: args.actor,
      inputs,
      steps: [],
      startedAt,
    }
    const entry = this.buildEntry(runId, args.spec, budget, state)
    this.runs.set(runId, entry)
    await this.deps.runMeta.save(runId, {
      spec: args.spec,
      budget,
      actor: args.actor,
      workflowName: args.spec.name,
      inputs,
      startedAt,
    })
    this.emit(state)

    await this.runStream(entry, { vars, steps: [], stepCount: 0, tokenCount: 0, startedAt, lastActiveAt: startedAt })
    return structuredClone(entry.state)
  }

  /**
   * Live per-node introspection (canvas: click a running agent, see its current thought/action/token
   * count). Reuses LmAgentDispatcher's existing fragment stream via `observeFragments` — independent of
   * its `ctx` binding (see lmAgentDispatcher.ts), so this never disturbs whatever `bind()` context the
   * chat participant or another caller has in place. A no-op when the injected dispatcher doesn't support
   * it (e.g. StubAgentDispatcher). Patches `RunStep.activity` directly on the runtime's own RunState
   * mirror (outside the checkpointed graph state) and throttles the resulting onRunUpdate broadcast so a
   * chatty token stream doesn't flood the webview.
   */
  private trackActivity(runId: string): { dispose(): void } {
    const dispatcher = this.deps.dispatcher as Partial<{
      observeFragments: (fn: (agentName: string, fragment: string, source?: FragmentSource) => void) => { dispose(): void }
    }>
    if (typeof dispatcher.observeFragments !== 'function') return { dispose: () => {} }

    let buffer = ''
    let lastEmit = 0
    const THROTTLE_MS = 150
    const MAX_BUFFER_CHARS = 2000

    const handle = dispatcher.observeFragments((_agentName, fragment, source) => {
      // Fragments from another concurrent run are not ours. (A dispatcher that can't attribute fragments
      // passes no source — then the single-active-run assumption still applies.)
      if (source?.runId && source.runId !== runId) return
      buffer += fragment
      if (buffer.length > MAX_BUFFER_CHARS) buffer = buffer.slice(-MAX_BUFFER_CHARS)

      const entry = this.runs.get(runId)
      if (!entry) return
      const step =
        (source?.stepId && entry.state.steps.find((s) => s.id === source.stepId && s.status === 'running')) ||
        [...entry.state.steps].reverse().find((s) => s.kind === 'agent' && s.status === 'running')
      if (!step) return

      const nowMs = this.now()
      step.activity = {
        thought: buffer,
        liveTokensOut: Math.max(1, Math.ceil(buffer.length / 4)),
        updatedAt: nowMs,
      }
      if (nowMs - lastEmit >= THROTTLE_MS) {
        lastEmit = nowMs
        this.emit(entry.state)
      }
    })
    return handle
  }

  /** Finds the run's entry, recompiling its StateGraph from persisted metadata if it isn't already cached
   * in-process — the path that gives a paused run durability across an extension-host restart. */
  private async getEntry(runId: string): Promise<RunEntry> {
    const cached = this.runs.get(runId)
    if (cached) return cached

    const meta = await this.deps.runMeta.get(runId)
    if (!meta) throw new Error(`Unknown run: ${runId}`)

    const placeholder: RunState = {
      runId,
      workflowName: meta.workflowName,
      actor: meta.actor,
      inputs: meta.inputs,
      steps: [],
      startedAt: meta.startedAt,
      status: 'running',
    }
    const entry = this.buildEntry(runId, meta.spec, meta.budget, placeholder)
    entry.state = this.reconstructState(runId, meta, await entry.graphApp.getState(this.config(runId)))
    this.runs.set(runId, entry)
    return entry
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private reconstructState(runId: string, meta: RunMeta, snap: any): RunState {
    const values = snap?.values ?? {}
    const steps: RunStep[] = values.steps ?? []
    const state: RunState = {
      runId,
      workflowName: meta.workflowName,
      actor: meta.actor,
      inputs: meta.inputs,
      steps,
      startedAt: meta.startedAt,
      status: 'running',
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const interrupts = ((snap?.tasks ?? []) as any[]).flatMap((t) => t.interrupts ?? [])
    if (interrupts.length > 0) {
      state.status = 'awaiting_approval'
      state.pendingApproval = pendingApprovalFromPayload(interrupts[0].value as InterruptPayload)
      return state
    }

    const failure = values.vars?.[RUN_FAILURE_KEY] as string | undefined
    if (failure) {
      state.status = 'failed'
      state.error = failure
      state.outputs = values.vars
      state.finishedAt = this.now()
      return state
    }

    // Run metadata exists only for runs that never reached a terminal state, so a snapshot with work still
    // queued (`next` non-empty, no interrupt) — or no checkpoint at all — means the host died mid-step.
    // Leaving it `running` would strand it forever (nothing is executing it), so surface it as failed.
    const midStep = Array.isArray(snap?.next) && snap.next.length > 0
    if (midStep || !Array.isArray(values.steps)) {
      state.status = 'failed'
      state.error = 'Run interrupted by an extension restart before it could finish.'
      state.finishedAt = this.now()
      return state
    }

    state.status = 'completed'
    state.outputs = values.vars
    state.finishedAt = this.now()
    return state
  }

  async getRun(runId: string): Promise<RunState | undefined> {
    try {
      const entry = await this.getEntry(runId)
      return structuredClone(entry.state)
    } catch {
      return undefined
    }
  }

  async restoreRuns(): Promise<RunState[]> {
    const metas = await this.deps.runMeta.list()
    const cutoff = this.now() - PAUSED_RUN_RETENTION_MS
    const keep = new Set<string>()
    const restored: RunState[] = []

    for (const { runId, meta } of metas) {
      if (meta.startedAt < cutoff) {
        await this.retire(runId)
        continue
      }
      try {
        const entry = await this.getEntry(runId)
        keep.add(runId)
        restored.push(structuredClone(entry.state))
        // A run that died mid-step is shown once (as failed) this session, then cleaned up like any other
        // terminal run so it doesn't come back on every reload.
        if (isTerminal(entry.state.status)) await this.retire(runId)
      } catch {
        // Unrecompilable metadata (e.g. a spec from an incompatible version): drop it rather than loop on it.
        await this.retire(runId)
      }
    }

    // Threads with no run metadata are leftovers (a node finishing after its run was cancelled, a crash).
    const checkpointer = this.deps.checkpointer as { pruneOrphans?: (keep: ReadonlySet<string>) => Promise<number> }
    await checkpointer.pruneOrphans?.(keep)
    return restored
  }

  /**
   * Streams one super-step chain (the initial invoke or a resume) and folds each chunk into the run's
   * RunState mirror. After the stream ends, `settle` reads the checkpoint to decide what state the run is in.
   */
  private async runStream(entry: RunEntry, input: unknown): Promise<void> {
    const runId = entry.state.runId
    const activity = this.trackActivity(runId)
    try {
      const stream = await entry.graphApp.stream(input, {
        ...this.config(runId),
        signal: entry.abort.signal,
        streamMode: ['updates', 'tasks'],
      })
      for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
        if (entry.state.status === 'cancelled') return
        this.foldChunk(entry, mode, chunk)
      }
    } catch (e) {
      // cancelRun already moved the run to `cancelled`; the abort surfacing as an AbortError is expected.
      if (entry.state.status === 'cancelled') return
      await this.failRun(entry, e)
      return
    } finally {
      activity.dispose()
    }
    if (entry.state.status === 'cancelled') return
    await this.settle(entry)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private foldChunk(entry: RunEntry, mode: string, chunk: any): void {
    if (mode === 'tasks') {
      // A task START event (it carries `input`; its finish event carries `result` instead).
      if (!chunk || chunk.result !== undefined || chunk.input === undefined) return
      const opens = provisionalFor(String(chunk.name), entry.nodes)
      if (!opens) return
      const id = stepIdFor(entry.state.runId, opens.nodeId, chunk.input.steps ?? [])
      if (entry.state.steps.some((s) => s.id === id)) return
      const provisional: RunStep = {
        id,
        nodeId: opens.nodeId,
        kind: opens.kind,
        label: opens.label,
        seq: 0,
        status: 'running',
        startedAt: this.now(),
      }
      entry.state.steps = mergeStepsById(entry.state.steps, [provisional])
      this.emit(entry.state)
      return
    }

    if (mode === 'updates' && chunk && typeof chunk === 'object') {
      let touched = false
      for (const [node, update] of Object.entries(chunk as Record<string, { steps?: RunStep[] } | undefined>)) {
        if (node === '__interrupt__' || !update || !Array.isArray(update.steps)) continue
        entry.state.steps = mergeStepsById(entry.state.steps, update.steps)
        touched = true
      }
      if (touched) this.emit(entry.state)
    }
  }

  /** Reads the checkpoint after a stream ends and moves the run to paused / completed / failed. */
  private async settle(entry: RunEntry): Promise<void> {
    const snap = await entry.graphApp.getState(this.config(entry.state.runId))
    const values = snap?.values ?? {}
    // The checkpoint is authoritative: it drops any provisional step that never produced a real one.
    if (Array.isArray(values.steps)) entry.state.steps = values.steps as RunStep[]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const interrupts = ((snap?.tasks ?? []) as any[]).flatMap((t) => t.interrupts ?? [])
    if (interrupts.length > 0) {
      entry.state.status = 'awaiting_approval'
      entry.state.pendingApproval = pendingApprovalFromPayload(interrupts[0].value as InterruptPayload)
      this.emit(entry.state)
      return
    }

    const vars = (values.vars as Record<string, unknown> | undefined) ?? {}
    const failure = vars[RUN_FAILURE_KEY] as string | undefined
    entry.state.status = failure ? 'failed' : 'completed'
    if (failure) entry.state.error = failure
    entry.state.outputs = vars
    entry.state.finishedAt = this.now()
    entry.state.pendingApproval = undefined
    this.emit(entry.state)
    await this.retire(entry.state.runId)
  }

  private async failRun(entry: RunEntry, e: unknown): Promise<void> {
    const message = e instanceof BudgetExceededError ? e.message : e instanceof Error ? e.message : String(e)
    try {
      // A node that throws discards its own update, so its provisional step has no real counterpart.
      const snap = await entry.graphApp.getState(this.config(entry.state.runId))
      if (Array.isArray(snap?.values?.steps)) entry.state.steps = snap.values.steps as RunStep[]
    } catch {
      // Best effort — the failure itself is what matters.
    }
    entry.state.status = 'failed'
    entry.state.error = message
    entry.state.finishedAt = this.now()
    entry.state.pendingApproval = undefined
    this.emit(entry.state)
    await this.retire(entry.state.runId)
  }

  /** Deletes a finished run's checkpoint thread and metadata. Best effort: cleanup must never fail a run. */
  private async retire(runId: string): Promise<void> {
    try {
      await this.deps.checkpointer.deleteThread(runId)
    } catch {
      // The orphan sweep in restoreRuns() will collect it on the next session.
    }
    try {
      await this.deps.runMeta.delete(runId)
    } catch {
      // A stale metadata row for a terminal run is harmless; restore marks/clears it.
    }
  }

  async submitApproval(runId: string, decision: ApprovalDecision): Promise<RunState> {
    const entry = await this.getEntry(runId)
    if (entry.state.status !== 'awaiting_approval') {
      throw new Error(`Run ${runId} is not awaiting approval (status: ${entry.state.status}).`)
    }
    entry.state.pendingApproval = undefined
    entry.state.status = 'running'
    this.emit(entry.state)

    await this.runStream(entry, new Command({ resume: decision }))
    return structuredClone(entry.state)
  }

  async cancelRun(runId: string): Promise<RunState> {
    const entry = await this.getEntry(runId)
    if (isTerminal(entry.state.status)) return structuredClone(entry.state)

    // Flip the state FIRST so the stream loop (which checks it) and a late-finishing node can't overwrite it.
    const finishedAt = this.now()
    entry.state.pendingApproval = undefined
    entry.state.status = 'cancelled'
    entry.state.finishedAt = finishedAt
    // Anything still mid-flight will never finish — don't leave it looking alive on the canvas.
    entry.state.steps = entry.state.steps.map((s) =>
      s.status === 'running' ? { ...s, status: 'skipped' as const, error: 'Run cancelled', finishedAt } : s,
    )
    entry.abort.abort()
    this.emit(entry.state)
    await this.retire(runId)
    return structuredClone(entry.state)
  }
}
