// Phase 4 (LangGraph) — shared per-node-function logic. LangGraph node functions must not rely on captured
// mutable state to survive a checkpoint/replay, so every node reconstructs its RunContext/GuardState from
// the state annotation on entry and returns them serialized back out. Direct analogue of
// MockWorkflowRuntime's beginStep/finishStep, expressed as pure state transforms.

import { RunContext } from '../context'
import { GuardState } from '../guards'
import type { RunBudget } from '../spec'
import type { RunStep } from '../port'
import type { RunGraphStateType, RunGraphUpdate } from './state'

export interface NodeRunHandle {
  ctx: RunContext
  guard: GuardState
  /** Counter values at node entry — `toUpdate` returns the DELTA since these (the state channels sum). */
  baseSteps: number
  baseTokens: number
  /** The run's clock, so `toUpdate` can stamp `lastActiveAt` (the start of any pause that follows). */
  now: () => number
}

/** Sentinel key stashed in `vars` to signal a graceful run failure (gate block, agent rejection, dispatch
 * error) — routing checks this instead of relying on thrown exceptions, since a thrown error from a node
 * function discards its state update and would lose the failed step's record. Real thrown exceptions are
 * reserved for genuinely unexpected errors and for BudgetExceededError from guard.tick() (which has no
 * associated step to preserve — mirrors MockWorkflowRuntime, where a budget trip happens before a step
 * begins). */
export const RUN_FAILURE_KEY = '__runFailure__'

function reconstruct(state: RunGraphStateType, budget: RunBudget, now: () => number): NodeRunHandle {
  const startedAt = state.startedAt || now()
  const guard = new GuardState(budget, startedAt, {
    steps: state.stepCount,
    tokens: state.tokenCount,
    startedAt,
    pausedMs: state.pausedMs,
  })
  return {
    ctx: new RunContext(state.vars),
    guard,
    baseSteps: state.stepCount,
    baseTokens: state.tokenCount,
    now,
  }
}

/**
 * The state update an interrupt node returns once it resumes: how long the run sat paused, measured from
 * when the last node finished (`lastActiveAt`) to now. An interrupting node returns no update while paused,
 * so on resume `lastActiveAt` still marks the moment the pause began. Spread into every return of an
 * `interrupt()` node so time spent awaiting a human never counts against the run's time budget.
 */
export function pauseUpdate(state: RunGraphStateType, now: () => number): Pick<RunGraphUpdate, 'pausedMs' | 'lastActiveAt'> {
  const resumedAt = now()
  const pausedMs = state.lastActiveAt > 0 ? Math.max(0, resumedAt - state.lastActiveAt) : 0
  return { pausedMs, lastActiveAt: resumedAt }
}

/**
 * Reconstructs RunContext + GuardState from checkpointed state and ticks the guard once (throws
 * BudgetExceededError on breach — same as MockWorkflowRuntime.drive's tick-before-execute). Call once per
 * logical spec node — for an `agent` node that's its `:plan` sub-node only, NOT `:approve`/`:execute`
 * (those continue the same logical step and must not inflate the step count a second/third time).
 */
export function beginNode(state: RunGraphStateType, budget: RunBudget, now: () => number): NodeRunHandle {
  const handle = reconstruct(state, budget, now)
  handle.guard.tick(now())
  return handle
}

/**
 * Reconstructs RunContext + GuardState WITHOUT ticking — for continuation sub-nodes (agent `:approve`/
 * `:execute`, approval `:wait`) that are part of a step already ticked by their `:plan`/`:begin` sibling.
 */
export function resumeNode(state: RunGraphStateType, budget: RunBudget, now: () => number): NodeRunHandle {
  return reconstruct(state, budget, now)
}

/** Finds the most recently opened 'running' step for a given node id — used by continuation sub-nodes to
 * locate the step their `:plan`/`:begin` sibling created. */
export function findRunningStep(state: RunGraphStateType, nodeId: string): RunStep | undefined {
  for (let i = state.steps.length - 1; i >= 0; i--) {
    if (state.steps[i].nodeId === nodeId && state.steps[i].status === 'running') return state.steps[i]
  }
  return undefined
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Deterministic id for the NEXT step a node will record: `<runId>-<nodeId>-<n>`, n = 1 + how many steps that
 * node already has (so a goto loop re-entering a node gets a fresh id). Unique across parallel branches
 * (different nodeIds) without any shared counter, and computable from a node's input state alone — which is
 * how LangGraphWorkflowRuntime gives a node's provisional "running" step the same id its real step will have.
 */
export function stepIdFor(runId: string, nodeId: string, steps: ReadonlyArray<Pick<RunStep, 'nodeId'>>): string {
  const prior = steps.reduce((n, s) => (s.nodeId === nodeId ? n + 1 : n), 0)
  return `${runId}-${nodeId}-${prior + 1}`
}

/** A fresh `running` step. `seq` is a placeholder — the state's `steps` reducer assigns the real one. */
export function makeStep(
  state: RunGraphStateType,
  runId: string,
  nodeId: string,
  kind: RunStep['kind'],
  label: string,
  now: number,
): RunStep {
  return { id: stepIdFor(runId, nodeId, state.steps), nodeId, kind, label, seq: 0, status: 'running', startedAt: now }
}

export function finishStep(step: RunStep, status: RunStep['status'], now: number, error?: string): RunStep {
  return { ...step, status, error: error ?? step.error, finishedAt: now }
}

/**
 * Builds the partial state update every node function returns: merged ctx vars, the step(s) touched this
 * call, the guard counter DELTAS (the `stepCount`/`tokenCount` channels sum — see state.ts), and the
 * finish time that starts any pause that follows.
 */
export function toUpdate(handle: NodeRunHandle, steps: RunStep[]): RunGraphUpdate {
  return {
    vars: handle.ctx.toBag(),
    steps,
    stepCount: handle.guard.stepCount - handle.baseSteps,
    tokenCount: handle.guard.tokenCount - handle.baseTokens,
    lastActiveAt: handle.now(),
  } as RunGraphUpdate
}
