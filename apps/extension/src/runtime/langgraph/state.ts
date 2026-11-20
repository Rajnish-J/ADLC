// Phase 4 (LangGraph) — the StateGraph state annotation. Carries the equivalent of MockWorkflowRuntime's
// RunContextState: a serializable variable bag (RunContext's dotted-key vars, replayed through a plain
// object since the checkpointer persists state as JSON, not live Map/class instances), the append-only
// RunStep history the UI already renders, and the GuardState counters (stepCount/tokenCount/startedAt) —
// tracked through the annotation rather than a closure, since LangGraph node functions must not depend on
// external mutable state for checkpoint/replay correctness.
//
// Parallel-safe by construction: when a node fans out to several successors they run in the same superstep,
// each reading the SAME input state. So `stepCount`/`tokenCount` are DELTA channels (nodes return how much
// they added, the reducer sums), and step `seq` is assigned here when a step is first inserted rather than
// derived from `steps.length` inside a node. Otherwise two parallel branches would overwrite each other's
// counters (under-counting the budget) and collide on ids/seq.

import { Annotation } from '@langchain/langgraph'
import type { RunStep } from '../port'

/**
 * Folds incoming steps into the existing list by id. A new id is appended and gets the next `seq`; an
 * existing id is replaced in place and keeps its original `seq` (so a step's position never changes as it
 * moves running -> succeeded). Shared with LangGraphWorkflowRuntime, which folds streamed updates into its
 * RunState mirror with the identical rule.
 */
export function mergeStepsById(existing: RunStep[], incoming: RunStep[]): RunStep[] {
  const out = existing.slice()
  for (const step of incoming) {
    const idx = out.findIndex((s) => s.id === step.id)
    if (idx === -1) out.push({ ...step, seq: out.length + 1 })
    else out[idx] = { ...step, seq: out[idx].seq }
  }
  return out
}

export const RunGraphState = Annotation.Root({
  vars: Annotation<Record<string, unknown>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  steps: Annotation<RunStep[]>({
    reducer: mergeStepsById,
    default: () => [],
  }),
  /** Total node executions so far. Nodes return a DELTA (see toUpdate); the reducer sums. */
  stepCount: Annotation<number>({
    reducer: (a, b) => a + b,
    default: () => 0,
  }),
  /** Total tokens so far. Nodes return a DELTA (see toUpdate); the reducer sums. */
  tokenCount: Annotation<number>({
    reducer: (a, b) => a + b,
    default: () => 0,
  }),
  startedAt: Annotation<number>({
    reducer: (a, b) => a ?? b,
    default: () => Date.now(),
  }),
  /** Total ms spent paused on interrupts (awaiting a human). DELTA channel; excluded from the time budget. */
  pausedMs: Annotation<number>({
    reducer: (a, b) => a + b,
    default: () => 0,
  }),
  /** When the most recent node finished — i.e. when any following pause began. Parallel writes keep the latest. */
  lastActiveAt: Annotation<number>({
    reducer: (a, b) => Math.max(a, b),
    default: () => 0,
  }),
})

export type RunGraphStateType = typeof RunGraphState.State
export type RunGraphUpdate = typeof RunGraphState.Update
