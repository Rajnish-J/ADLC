// Phase 4 — the WorkflowRuntime port.
//
// The seam between the extension (client) and whatever executes a workflow. MockWorkflowRuntime implements
// this in-process now; FoundryWorkflowRuntime implements it against Foundry later (per the P4.0 spike). The
// extension's run-lifecycle client and Runs view depend ONLY on this interface, so swapping runtimes changes
// nothing upstream. Framework-free (no `vscode`) so the core stays unit-testable.

import type { GateDecision } from '../eval/types'
import type { SdlcStep } from '../eval/sdlcSteps'
import type { RunBudget, SpecNodeKind, WorkflowSpec } from './spec'

/** Normalized run status. Maps onto Foundry's queued/in_progress/requires_action/completed/failed/cancelled. */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type RunStepStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'blocked'

/**
 * Live, in-progress introspection for a `running` agent step — the LangGraph runtime patches this in
 * place (via its own onFragment binding to the dispatcher, outside the checkpointed graph state) as text
 * streams in, so the canvas can show "what is this agent doing right now" before the step finalizes.
 * Additive/optional: MockWorkflowRuntime never sets it, and consumers degrade gracefully when absent.
 */
export interface RunStepActivity {
  /** Latest streamed text, accumulated for a live "current thought" card. */
  thought?: string
  /** One-line summary of the current/most recent tool call, e.g. "write_file(src/x.ts)". */
  action?: string
  /** Running token counts, updated as fragments arrive — before the step's own tokensIn/tokensOut finalize. */
  liveTokensIn?: number
  liveTokensOut?: number
  /** Monotonic timestamp so the webview can ignore out-of-order postMessage delivery. */
  updatedAt: number
}

/** One executed node, persisted append-only as the run progresses. */
export interface RunStep {
  id: string
  nodeId: string
  kind: SpecNodeKind
  label: string
  seq: number
  status: RunStepStatus
  /** Agent response or action output, when relevant. */
  output?: string
  /** Present on agent steps — the tool-free plan generated before human approval was requested. */
  plan?: string
  tokensIn?: number
  tokensOut?: number
  /** Present on gate steps — the enforcing decision. */
  gateDecision?: GateDecision
  error?: string
  startedAt: number
  finishedAt?: number
  /** Live streaming detail while status === 'running' — see RunStepActivity. */
  activity?: RunStepActivity
}

/** Surfaced when a run pauses on an approval node. */
export interface PendingApproval {
  stepId: string
  nodeId: string
  question: string
  /** Default answer if the human does not respond. */
  default?: string
  /** Present when pausing on an agent's plan — the tool-free plan text for the human to review. */
  plan?: string
}

/** A human approval decision fed back to resume a paused run. */
export interface ApprovalDecision {
  approve: boolean
  /** Optional free-text comment recorded in the audit trail. */
  comment?: string
  /** Who decided — for attribution in the audit store. */
  actor: string
}

/** The full state of a run. Returned by every port method and emitted on change. */
export interface RunState {
  runId: string
  workflowName: string
  status: RunStatus
  /** The signed-in user the run is attributable to. */
  actor: string
  inputs: Record<string, unknown>
  steps: RunStep[]
  pendingApproval?: PendingApproval
  outputs?: Record<string, unknown>
  error?: string
  startedAt: number
  finishedAt?: number
}

export interface StartRunArgs {
  spec: WorkflowSpec
  inputs?: Record<string, unknown>
  actor: string
  /** Overrides the spec's budget for this run. */
  budget?: RunBudget
  /**
   * Caller-chosen run id. Lets a caller bind per-run dispatch context before the run starts (runs drive
   * synchronously inside startRun), and lets a backend use its own ids. Generated when omitted.
   */
  runId?: string
}

/** Unsubscribe handle for run-update listeners. */
export type Unsubscribe = () => void

/**
 * The runtime contract. All methods are async so the Foundry adapter (network-bound) satisfies the same
 * shape as the in-process mock.
 */
export interface WorkflowRuntime {
  startRun(args: StartRunArgs): Promise<RunState>
  getRun(runId: string): Promise<RunState | undefined>
  /** Resume a run paused on its pending approval. Throws if the run is not awaiting approval. */
  submitApproval(runId: string, decision: ApprovalDecision): Promise<RunState>
  cancelRun(runId: string): Promise<RunState>
  /** Subscribe to run-state changes (for live UI). Returns an unsubscribe fn. */
  onRunUpdate(listener: (state: RunState) => void): Unsubscribe
  /**
   * Optional: re-hydrate runs that outlived the previous extension-host session (paused awaiting approval,
   * or interrupted mid-step) so the host can list and resume them. Engines with no durable store (the
   * in-process interpreter) simply don't implement it.
   */
  restoreRuns?(): Promise<RunState[]>
}

// --- Injected dependencies the runtime uses to execute a run ------------------------------------

/** Input handed to an agent dispatch. */
export interface AgentDispatchInput {
  /**
   * The run this dispatch belongs to. Dispatchers key per-run state on it (bound context, files written
   * so far, live-activity observers), so concurrent runs never share or clobber each other's context.
   */
  runId?: string
  /** The spec node and run step being dispatched — for attribution and live per-step activity. */
  nodeId?: string
  stepId?: string
  agentId: string
  agentName: string
  /** The prompt assembled from the run context (typically the prior step's output / handoff). */
  prompt: string
  /**
   * The persistent work item / task seed for the run. Unlike `prompt` (which is overwritten by each
   * agent's reply), this is the same for every agent step so downstream agents never lose sight of
   * what they are working on. Empty when the run wasn't seeded from a work item.
   */
  workItem?: string
  /** Azure DevOps identifiers for the seeded work item, when the run came from an issue trigger. */
  workItemId?: number
  workItemUrl?: string
  /**
   * Every agent dispatch is now two-phase: `plan` produces a concrete, tool-free plan for a human to
   * review; `execute` (only sent after human approval) carries out the work, informed by that plan.
   */
  phase: 'plan' | 'execute'
  /** The human-approved plan text, set only when `phase === 'execute'`. */
  approvedPlan?: string
  /**
   * Aborted when the run is cancelled. Dispatchers that can stop in-flight work (LmAgentDispatcher cancels its
   * model request) should honour it; ignoring it is safe — the runtime also stops at the next node boundary.
   */
  signal?: AbortSignal
}

/** Which run/step a streamed agent fragment belongs to (for live per-step activity across concurrent runs). */
export interface FragmentSource {
  runId?: string
  stepId?: string
}

export interface AgentDispatchResult {
  response: string
  tokensIn: number
  tokensOut: number
  /** Best-effort structured vars parsed from the response, merged into the run context. */
  structured?: Record<string, unknown>
}

/** Dispatches an agent step. StubAgentDispatcher (mock) vs FoundryAgentDispatcher (real). */
export interface AgentDispatcher {
  dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult>
}

/** Everything a gate gets to judge one step's output. `query`/`signal` are additive and optional. */
export interface GateEvaluationInput {
  sdlcStep: SdlcStep
  /** The step's output being gated (the previous agent's response). */
  output: string
  /** What the output was supposed to address — the run's seed work item/task. Evaluators like task
   *  adherence and intent resolution need it; the stub ignores it. */
  query?: string
  /** Aborted when the run is cancelled, so a slow evaluation stops instead of outliving its run. */
  signal?: AbortSignal
}

/** Evaluates a gate step. StubGateEvaluator (mock) vs the real Phase-3 evalClient + decideGate. */
export interface GateEvaluator {
  evaluate(input: GateEvaluationInput): Promise<GateDecision>
}
