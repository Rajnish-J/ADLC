// A local run's state → the snapshot the platform stores for the story (ReportRunInput). Pure — unit-tested.
// Outputs are clipped to the platform's limits; the files each agent step wrote and each approval decision come
// from the reporter (the run state itself records neither).

import {
  MAX_STEP_OUTPUT_CHARS,
  MAX_STEP_PLAN_CHARS,
  type ApprovalRecord,
  type ReportRunInput,
  type RunStepReport,
  type SkillUse,
} from '@sdlc/contracts'
import type { RunState, WorkflowSpec } from '../../runtime/port'

const iso = (ms: number | undefined): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null)
const clip = (text: string | undefined, max: number): string | null => (text ? (text.length > max ? `${text.slice(0, max)}…` : text) : null)
const count = (n: number | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : null)

export interface RunExtras {
  /** Workspace-relative files written per step (from the dispatcher's write events). */
  changedFiles: ReadonlyMap<string, readonly string[]>
  /** Approval decisions per step (from RunService's decide events). */
  approvals: ReadonlyMap<string, ApprovalRecord>
  /** The spec the run started with: which agent and skills each agent step is bound to. */
  spec?: WorkflowSpec
  /** For runs in a harness: the harness, model and task, and per step the skills used and tool calls. */
  harness?: {
    engine: string
    engineModel: string | null
    engineSessionId: string | null
    workflowId: string | null
    workflowVersion: number | null
    taskNumber: number | null
    skillsUsed: (stepId: string) => SkillUse[]
    toolCalls: (stepId: string) => number | null
  }
}

/** The agent and skills an agent node is bound to in the spec. */
function bindingOf(spec: WorkflowSpec | undefined, nodeId: string): { agentSlug: string | null; agentName: string | null; skills: string[] } {
  const node = spec?.nodes.find((n) => n.id === nodeId)
  if (!node || node.kind !== 'agent') return { agentSlug: null, agentName: null, skills: [] }
  const slug = typeof node.data.agentId === 'string' && node.data.agentId ? node.data.agentId : null
  const name = typeof node.data.agentName === 'string' && node.data.agentName ? node.data.agentName : slug
  const skills = Array.isArray(node.data.skills) ? node.data.skills.filter((x): x is string => typeof x === 'string') : []
  return { agentSlug: slug?.slice(0, 200) ?? null, agentName: name?.slice(0, 200) ?? null, skills: skills.slice(0, 50) }
}

export function toRunReport(state: RunState, extras: RunExtras): ReportRunInput {
  const steps: RunStepReport[] = state.steps.slice(-200).map((s) => ({
    stepId: s.id,
    seq: s.seq,
    nodeId: s.nodeId,
    kind: s.kind,
    label: s.label.slice(0, 300),
    status: s.status,
    startedAt: iso(s.startedAt),
    finishedAt: iso(s.finishedAt),
    tokensIn: count(s.tokensIn),
    tokensOut: count(s.tokensOut),
    gatePass: s.gateDecision ? s.gateDecision.pass : null,
    gateReason: clip(s.gateDecision?.reason, 2_000),
    approval: extras.approvals.get(s.id) ?? null,
    output: clip(s.output, MAX_STEP_OUTPUT_CHARS),
    plan: clip(s.plan, MAX_STEP_PLAN_CHARS),
    error: clip(s.error, 4_000),
    changedFiles: [...(extras.changedFiles.get(s.id) ?? [])].slice(0, 500),
    // The evaluator scores behind a gate verdict, so the web shows the same evaluation the Runs tree does.
    evaluations: (s.gateDecision?.perEvaluator ?? []).slice(0, 50).map((e) => ({
      evaluator: String(e.evaluator).slice(0, 200),
      score: typeof e.score === 'number' && Number.isFinite(e.score) ? e.score : null,
      threshold: typeof e.threshold === 'number' && Number.isFinite(e.threshold) ? e.threshold : null,
      pass: e.pass,
      required: typeof e.required === 'boolean' ? e.required : null,
      reason: e.reason ? e.reason.slice(0, 2_000) : null,
    })),
    reportUrl: s.gateDecision?.reportUrl?.slice(0, 2_000) ?? null,
    ...bindingOf(extras.spec, s.nodeId),
    skillsUsed: extras.harness?.skillsUsed(s.id).slice(0, 50) ?? [],
    model: s.kind === 'agent' ? (extras.harness?.engineModel?.slice(0, 120) ?? null) : null,
    toolCalls: s.kind === 'agent' ? (extras.harness?.toolCalls(s.id) ?? null) : null,
  }))
  return {
    workflowName: state.workflowName.slice(0, 200) || 'Workflow',
    status: state.status,
    startedAt: iso(state.startedAt) ?? new Date().toISOString(),
    finishedAt: iso(state.finishedAt),
    error: clip(state.error, 4_000),
    pendingApproval: state.pendingApproval
      ? { stepId: state.pendingApproval.stepId, question: (state.pendingApproval.question ?? '').slice(0, 2_000) }
      : null,
    steps,
    engine: extras.harness?.engine ?? null,
    engineModel: extras.harness?.engineModel ?? null,
    engineSessionId: extras.harness?.engineSessionId ?? null,
    workflowId: extras.harness?.workflowId ?? null,
    workflowVersion: extras.harness?.workflowVersion ?? null,
    taskNumber: extras.harness?.taskNumber ?? null,
  }
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunState['status']> = new Set(['completed', 'failed', 'cancelled'])
