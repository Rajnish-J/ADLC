// Phase 4 — runtime guards. Adapted from the orka orchestrator
// (claude-code-analytics src/lib/orka/orchestrator/guards.ts), with `AppError`/`RunGuards` swapped for a
// local error + our RunBudget, and token-budget tracking added. Prevents goto loops from running forever or
// burning unbounded tokens. The interpreter calls tick() before every node execution and addTokens() after
// each agent step.

import type { RunBudget } from './spec'

/** Thrown when a run trips a budget. The interpreter catches it and fails the run with this as the reason. */
export class BudgetExceededError extends Error {
  constructor(
    message: string,
    /** A machine-readable cause for the audit entry. */
    readonly cause: 'max-steps' | 'timeout' | 'max-tokens',
  ) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

export class GuardState {
  private steps: number
  private tokens: number
  private paused: number
  private readonly startedAt: number

  /**
   * `resume` seeds counters from a previously persisted state (e.g. a LangGraph node reconstructing a
   * GuardState from checkpointed `stepCount`/`tokenCount`/`startedAt`/`pausedMs` on every invocation, since
   * node functions can't rely on a captured closure surviving a checkpoint/resume). Omit for a fresh run.
   */
  constructor(
    private readonly budget: RunBudget,
    now: number,
    resume?: { steps?: number; tokens?: number; startedAt?: number; pausedMs?: number },
  ) {
    this.steps = resume?.steps ?? 0
    this.tokens = resume?.tokens ?? 0
    this.paused = resume?.pausedMs ?? 0
    this.startedAt = resume?.startedAt ?? now
  }

  get stepCount(): number {
    return this.steps
  }

  get tokenCount(): number {
    return this.tokens
  }

  /** Total time the run has spent paused awaiting a human — excluded from the time limit. */
  get pausedMs(): number {
    return this.paused
  }

  /** Records time spent paused (e.g. on a plan approval) so it doesn't count against the time limit. */
  addPausedMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.paused += ms
  }

  /**
   * Counts one node execution. Throws when the step budget or the time limit is exhausted. The time limit
   * measures active time — wall clock since start minus time spent paused awaiting approval — so a run a
   * human leaves waiting overnight still resumes.
   */
  tick(now: number): void {
    this.steps += 1
    if (this.steps > this.budget.maxSteps) {
      throw new BudgetExceededError(
        `Halted after ${this.budget.maxSteps} node executions — check for an unbounded goto loop.`,
        'max-steps',
      )
    }
    if (now - this.startedAt - this.paused > this.budget.timeoutMs) {
      throw new BudgetExceededError(
        `Exceeded ${Math.round(this.budget.timeoutMs / 1000)}s run-time limit (time awaiting approval excluded).`,
        'timeout',
      )
    }
  }

  /** Accumulates token usage from an agent step. Throws when the optional token budget is exceeded. */
  addTokens(tokensIn: number, tokensOut: number): void {
    this.tokens += (tokensIn || 0) + (tokensOut || 0)
    const max = this.budget.maxTokens ?? 0
    if (max > 0 && this.tokens > max) {
      throw new BudgetExceededError(
        `Halted after ${this.tokens} tokens — exceeded the ${max}-token per-run budget.`,
        'max-tokens',
      )
    }
  }
}
