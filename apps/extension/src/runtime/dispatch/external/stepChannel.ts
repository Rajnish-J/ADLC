// The hand-off between the workflow runtime and a harness (Copilot, Claude Code, Codex…) running a run's agent
// steps. The runtime dispatches each agent step twice — plan, then (after a human approves) execute — and waits;
// the harness, driven by the SDLC tools, polls `next` for work, submits the plan, and later completes the step.
// Pure (no vscode), so the protocol is unit-testable.

import type { AgentDispatchInput, AgentDispatchResult } from '../../port'

export type StepPhase = 'plan' | 'execute'

export interface SkillRef {
  slug: string
  name: string
  /** Where the skill's instructions are in the workspace, for the harness to read. */
  path?: string
}

export interface StepAssignment {
  action: StepPhase
  stepId: string
  nodeId: string
  agentId: string
  agentName: string
  /** What to do now: the step's prompt (prior output / handoff) and, for execute, the approved plan. */
  instructions: string
  workItem?: string
  approvedPlan?: string
  skills: SkillRef[]
  /** The catalog agent's own instructions (its role), and where they were written in the workspace. */
  agentInstructions?: string
  agentFile?: string
}

/** What the channel's owner knows about an agent step beyond the dispatch itself. */
export interface StepExtras {
  skills: SkillRef[]
  agentInstructions?: string
  agentFile?: string
}

export type NextStep =
  | StepAssignment
  | { action: 'waiting'; reason: 'approval' | 'gate' | 'idle'; retryAfterSec: number; message: string }
  | { action: 'done' | 'stopped'; reason?: string }

interface Pending {
  key: string
  phase: StepPhase
  input: AgentDispatchInput
  createdAt: number
  deliveredAt?: number
  resolve(r: AgentDispatchResult): void
  reject(e: Error): void
}

export interface CompleteOptions {
  skillsUsed?: string[]
  tokensIn?: number
  tokensOut?: number
  structured?: Record<string, unknown>
  /** Run variables the step sets (the SDLC tool's `outputs`); merged into the run context like `structured`. */
  outputs?: Record<string, unknown>
}

/** What the channel tells its owner, for activity reporting and UI. */
export type ChannelEvent =
  | { type: 'delivered'; runId: string; phase: StepPhase; input: AgentDispatchInput }
  | { type: 'plan.submitted'; runId: string; stepId: string; plan: string }
  | { type: 'step.completed'; runId: string; stepId: string; summary: string; skillsUsed: string[] }

export class StepChannel {
  private readonly pending = new Map<string, Pending[]>()
  private readonly pollers = new Map<string, Array<() => void>>()
  private readonly finished = new Map<string, 'done' | 'stopped'>()
  private readonly listeners = new Set<(e: ChannelEvent) => void>()

  constructor(
    /** Skills and agent instructions bound to an agent step (from the run's spec), with where they were written. */
    private readonly extrasOf: (runId: string, nodeId: string, agentId: string) => StepExtras = () => ({ skills: [] }),
    /** Why nothing is pending right now (the run is waiting for a human, or a gate is running). */
    private readonly idleReason: (runId: string) => 'approval' | 'gate' | 'idle' = () => 'idle',
    private readonly now: () => number = () => Date.now(),
  ) {}

  onEvent(fn: (e: ChannelEvent) => void): { dispose(): void } {
    this.listeners.add(fn)
    return { dispose: () => this.listeners.delete(fn) }
  }

  private emit(e: ChannelEvent): void {
    for (const fn of this.listeners) fn(e)
  }

  /** The runtime dispatched an agent phase: park it until the harness picks it up and answers. */
  enqueue(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    const runId = input.runId ?? ''
    const stepId = input.stepId ?? input.nodeId ?? input.agentId
    return new Promise<AgentDispatchResult>((resolve, reject) => {
      const entry: Pending = {
        key: `${stepId}:${input.phase}`,
        phase: input.phase,
        input,
        createdAt: this.now(),
        resolve: (r) => {
          this.remove(runId, entry)
          resolve(r)
        },
        reject: (e) => {
          this.remove(runId, entry)
          reject(e)
        },
      }
      const list = this.pending.get(runId) ?? []
      list.push(entry)
      this.pending.set(runId, list)
      this.finished.delete(runId)
      input.signal?.addEventListener('abort', () => entry.reject(new Error('The run was cancelled.')), { once: true })
      this.wake(runId)
    })
  }

  private remove(runId: string, entry: Pending): void {
    const list = this.pending.get(runId)
    if (!list) return
    const i = list.indexOf(entry)
    if (i >= 0) list.splice(i, 1)
  }

  private wake(runId: string): void {
    const waiting = this.pollers.get(runId) ?? []
    this.pollers.delete(runId)
    for (const fn of waiting) fn()
  }

  /** The step the harness is (or should be) working on: the oldest unanswered dispatch, redelivered if asked again. */
  private current(runId: string): Pending | undefined {
    return (this.pending.get(runId) ?? [])[0]
  }

  private assignment(runId: string, p: Pending): StepAssignment {
    const firstDelivery = p.deliveredAt === undefined
    if (firstDelivery) p.deliveredAt = this.now()
    const { input } = p
    if (firstDelivery) this.emit({ type: 'delivered', runId, phase: p.phase, input })
    const extras = this.extrasOf(runId, input.nodeId ?? '', input.agentId)
    return {
      action: p.phase,
      stepId: input.stepId ?? input.nodeId ?? input.agentId,
      nodeId: input.nodeId ?? '',
      agentId: input.agentId,
      agentName: input.agentName,
      instructions: input.prompt,
      workItem: input.workItem || undefined,
      approvedPlan: input.approvedPlan,
      skills: extras.skills,
      agentInstructions: extras.agentInstructions,
      agentFile: extras.agentFile,
    }
  }

  /**
   * What the harness should do next. Returns immediately when work is pending or the run is over; otherwise waits
   * up to `waitMs` for the runtime to dispatch, then says why it is still waiting so the harness polls again.
   */
  async poll(runId: string, waitMs = 45_000): Promise<NextStep> {
    const ready = this.ready(runId)
    if (ready) return ready
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, waitMs)
      function done() {
        clearTimeout(timer)
        resolve()
      }
      const list = this.pollers.get(runId) ?? []
      list.push(done)
      this.pollers.set(runId, list)
    })
    const after = this.ready(runId)
    if (after) return after
    const reason = this.idleReason(runId)
    const message =
      reason === 'approval'
        ? 'Your plan is waiting for a human to approve it in VS Code (or the web). Call sdlc_next_step again to continue.'
        : reason === 'gate'
          ? 'A governance gate is evaluating the last step. Call sdlc_next_step again.'
          : 'Nothing to do yet. Call sdlc_next_step again.'
    return { action: 'waiting', reason, retryAfterSec: 5, message }
  }

  private ready(runId: string): NextStep | undefined {
    const p = this.current(runId)
    if (p) return this.assignment(runId, p)
    const end = this.finished.get(runId)
    if (end) return { action: end }
    return undefined
  }

  private find(runId: string, stepId: string, phase: StepPhase): Pending {
    const p = (this.pending.get(runId) ?? []).find((x) => x.key === `${stepId}:${phase}`)
    if (!p) {
      const cur = this.current(runId)
      const expected = cur ? `${cur.input.stepId}:${cur.phase}` : 'nothing'
      throw new Error(`Step ${stepId} is not waiting for a ${phase} (the run expects ${expected}). Call sdlc_next_step to see what to do.`)
    }
    return p
  }

  /** The harness submitted the step's plan: the runtime pauses for a human to approve it. */
  submitPlan(runId: string, stepId: string, plan: string): void {
    const p = this.find(runId, stepId, 'plan')
    this.emit({ type: 'plan.submitted', runId, stepId, plan })
    p.resolve({ response: plan.trim() || '(no plan given)', tokensIn: 0, tokensOut: 0 })
  }

  /** The harness finished the step's work: its summary becomes the step's output and the next step's input. */
  complete(runId: string, stepId: string, summary: string, opts: CompleteOptions = {}): void {
    const p = this.find(runId, stepId, 'execute')
    const skillsUsed = [...new Set(opts.skillsUsed ?? [])]
    this.emit({ type: 'step.completed', runId, stepId, summary, skillsUsed })
    p.resolve({
      response: summary.trim() || '(no summary given)',
      tokensIn: opts.tokensIn ?? 0,
      tokensOut: opts.tokensOut ?? 0,
      structured: opts.structured ?? opts.outputs,
    })
  }

  /** The run ended (completed, failed or cancelled): pending dispatches fail and pollers are told to stop. */
  finish(runId: string, outcome: 'done' | 'stopped', reason = 'The run ended.'): void {
    this.finished.set(runId, outcome)
    for (const p of [...(this.pending.get(runId) ?? [])]) p.reject(new Error(reason))
    this.pending.delete(runId)
    this.wake(runId)
  }

  /** Whether a step of this run is waiting on the harness, and since when (for "Step finished?" nudges). */
  waitingSince(runId: string): number | undefined {
    const p = this.current(runId)
    return p ? (p.deliveredAt ?? p.createdAt) : undefined
  }

  forget(runId: string): void {
    this.pending.delete(runId)
    this.pollers.delete(runId)
    this.finished.delete(runId)
  }
}
