// Steps from the platform's orchestrator, for one harness in this window. The orchestrator runs the workflow (every
// node is a LangGraph node on the server) and hands each agent step to the harness pinned to it; this source is
// what that harness's SDLC tools call: long-poll for its next step, submit the plan, complete the step. It records
// when the harness last polled, so the session can tell whether the harness is still working on the run or has to
// be (re)opened. Framework-free (no vscode), so it is unit-tested with a stub client.

import type { NextStep, StepAssignment } from '@sdlc/contracts'
import type { PlatformClient } from '../platformClient'
import type { StepCompleteOptions, StepEvent, StepSource } from './stepSource'

/** The part of the platform client a remote step source uses. */
export type StepClient = Pick<PlatformClient, 'nextStep' | 'submitPlan' | 'completeStep'>

export interface RemoteStepSourceOptions {
  /** The platform client, or a getter for the current one (the connection can change while a run lasts). */
  client: StepClient | (() => StepClient | undefined)
  projectKey: string
  /** The harness this source serves (`claude-code`, `copilot`, …): the platform hands it only its own steps. */
  harness: string
  /** This VS Code window's presence id. */
  clientId?: string
  /** Fill in what only this window knows: where the step's skills and agent instructions were written. */
  enrich?: (assignment: StepAssignment) => StepAssignment
  /**
   * Before a step is completed: report what the run changed so far and return the files this step changed. It never
   * blocks completion for long, and a failure only means the step goes without its file list.
   */
  beforeComplete?: (runId: string, stepId: string, step: CompletingStep) => Promise<string[] | undefined>
  /**
   * The tokens the harness spent on this step since the last call (read from its transcript), sent with the plan
   * and with the completion. Undefined when the harness doesn't expose its usage.
   */
  takeTokens?: (runId: string, stepId: string) => { tokensIn: number; tokensOut: number } | undefined
  now?: () => number
}

/** What a step reported as it completes: its summary, and the agent that did it. */
export interface CompletingStep {
  summary: string
  agentName?: string
}

/** The longest a step's completion waits for its change snapshot. */
const SNAPSHOT_WAIT_MS = 20_000

const DEFAULT_WAIT_MS = 25_000
const MAX_WAIT_MS = 50_000
/** Results after which the harness has been told to end its turn. */
const TURN_ENDS = new Set<NextStep['action']>(['handoff', 'done', 'stopped'])

const isAssignment = (n: NextStep): n is StepAssignment => n.action === 'plan' || n.action === 'execute'

export class RemoteStepSource implements StepSource {
  readonly projectKey: string
  readonly harness: string
  private _lastPollAt: number | undefined
  private inFlight = 0
  private lastAction: NextStep['action'] | undefined
  private readonly delivered = new Set<string>()
  /** The agent each delivered step runs as (for the step commit message). */
  private readonly agentNames = new Map<string, string>()
  private readonly listeners = new Set<(e: StepEvent) => void>()
  private readonly resultListeners = new Set<(runId: string, next: NextStep) => void>()
  private readonly now: () => number

  constructor(private readonly opts: RemoteStepSourceOptions) {
    this.projectKey = opts.projectKey
    this.harness = opts.harness
    this.now = opts.now ?? (() => Date.now())
  }

  /** When the harness last asked for its next step (start or end of its latest poll); undefined if it never has. */
  get lastPollAt(): number | undefined {
    return this._lastPollAt
  }

  /** A poll is waiting on the platform right now. */
  get polling(): boolean {
    return this.inFlight > 0
  }

  /** The harness was last told to end its turn (handoff, done or stopped) and has not polled since. */
  get idle(): boolean {
    return this.inFlight === 0 && this.lastAction !== undefined && TURN_ENDS.has(this.lastAction)
  }

  /** Whether the harness is still working on the run: polling now, or polled within `withinMs`. */
  isActive(withinMs = 20_000): boolean {
    if (this.inFlight > 0) return true
    return this._lastPollAt !== undefined && this.now() - this._lastPollAt <= withinMs
  }

  /** Step activity (delivered, plan submitted, step completed), in the same shape as the local channel's. */
  onEvent(fn: (e: StepEvent) => void): { dispose(): void } {
    this.listeners.add(fn)
    return { dispose: () => this.listeners.delete(fn) }
  }

  /** Every answer the harness got from a poll (after enrichment). */
  onResult(fn: (runId: string, next: NextStep) => void): { dispose(): void } {
    this.resultListeners.add(fn)
    return { dispose: () => this.resultListeners.delete(fn) }
  }

  private client(): StepClient {
    const c = typeof this.opts.client === 'function' ? this.opts.client() : this.opts.client
    if (!c) throw new Error('Not connected to the SDLC platform. Reconnect VS Code to the platform, then call the tool again.')
    return c
  }

  private emit(e: StepEvent): void {
    for (const fn of this.listeners) fn(e)
  }

  async poll(runId: string, waitMs = DEFAULT_WAIT_MS): Promise<NextStep> {
    const client = this.client()
    const wait = Math.round(Math.min(MAX_WAIT_MS, Math.max(0, waitMs)) / 1000)
    this.inFlight++
    this._lastPollAt = this.now()
    this.lastAction = undefined
    let next: NextStep
    try {
      next = await client.nextStep(this.projectKey, runId, { harness: this.harness, clientId: this.opts.clientId, wait })
    } finally {
      this.inFlight--
      this._lastPollAt = this.now()
    }
    if (isAssignment(next)) next = this.deliver(runId, next)
    this.lastAction = next.action
    for (const fn of this.resultListeners) fn(runId, next)
    return next
  }

  private deliver(runId: string, raw: StepAssignment): StepAssignment {
    const a = this.opts.enrich ? this.opts.enrich(raw) : raw
    this.agentNames.set(a.stepId, a.agentName)
    const key = `${a.stepId}:${a.action}`
    if (!this.delivered.has(key)) {
      this.delivered.add(key)
      this.emit({
        type: 'delivered',
        runId,
        phase: a.action,
        stepId: a.stepId,
        agentId: a.agentId,
        agentName: a.agentName,
        instructions: a.instructions,
        approvedPlan: a.approvedPlan,
        harness: a.harness ?? this.harness,
      })
    }
    return a
  }

  async submitPlan(runId: string, stepId: string, plan: string): Promise<void> {
    await this.client().submitPlan(this.projectKey, runId, stepId, { plan, ...this.opts.takeTokens?.(runId, stepId) })
    this.emit({ type: 'plan.submitted', runId, stepId, plan })
  }

  private async changedFiles(runId: string, stepId: string, summary: string): Promise<string[] | undefined> {
    if (!this.opts.beforeComplete) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.opts.beforeComplete(runId, stepId, { summary, agentName: this.agentNames.get(stepId) }),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), SNAPSHOT_WAIT_MS)
        }),
      ])
    } catch {
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async complete(runId: string, stepId: string, summary: string, opts: StepCompleteOptions = {}): Promise<void> {
    const skillsUsed = [...new Set(opts.skillsUsed ?? [])]
    const client = this.client()
    const changedFiles = await this.changedFiles(runId, stepId, summary)
    await client.completeStep(this.projectKey, runId, stepId, {
      summary,
      skillsUsed,
      ...this.opts.takeTokens?.(runId, stepId),
      ...(opts.outputs ? { outputs: opts.outputs } : {}),
      ...(changedFiles?.length ? { changedFiles } : {}),
    })
    this.emit({ type: 'step.completed', runId, stepId, summary, skillsUsed })
  }
}
