// Where a harness's SDLC tools get their steps from. Two sources: the local StepChannel (the extension runs the
// workflow itself and parks each agent step on the channel) and RemoteStepSource (the platform's orchestrator runs
// the workflow and hands each agent step to a harness over HTTP). The tools (sdlcTools.ts) only see this interface.
// Pure types (no vscode).

import type { NextStep } from '@sdlc/contracts'

export type StepPhase = 'plan' | 'execute'

/** What a harness may pass when it finishes a step. */
export interface StepCompleteOptions {
  /** Slugs of the skills the agent says it used. */
  skillsUsed?: string[]
  /** Run variables the step sets (e.g. `Local.TestsPassed`), for later conditions to branch on. */
  outputs?: Record<string, unknown>
}

export interface StepSource {
  /**
   * What the harness should do next: a step to plan or execute, `waiting` (poll again), `handoff` (another harness
   * has the next step — end the turn), or `done` / `stopped`. May wait up to `waitMs` for work.
   */
  poll(runId: string, waitMs?: number): Promise<NextStep>
  /** The harness's plan for a step in its plan phase. Throws when the step is not waiting for a plan. */
  submitPlan(runId: string, stepId: string, plan: string): void | Promise<void>
  /** The harness finished a step in its execute phase. Throws when the step is not waiting to be executed. */
  complete(runId: string, stepId: string, summary: string, opts?: StepCompleteOptions): void | Promise<void>
}

/**
 * What a step source reports as the harness works, in the same shape for both sources, so the run's activity log
 * reads the same whoever drives the workflow.
 */
export type StepEvent =
  | {
      type: 'delivered'
      runId: string
      phase: StepPhase
      stepId: string
      agentId: string
      agentName: string
      instructions: string
      approvedPlan?: string
      /** The harness the step was handed to (remote steps). */
      harness?: string
    }
  | { type: 'plan.submitted'; runId: string; stepId: string; plan: string }
  | { type: 'step.completed'; runId: string; stepId: string; summary: string; skillsUsed: string[] }
