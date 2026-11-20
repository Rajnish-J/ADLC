// Sends a harness run's activity (steps, agents, skills, tool calls, files, plans, approvals) to the platform in
// one-second batches. Each event gets the run's next seq — persisted, so a reload continues the sequence — and the
// API ignores repeats, so a batch is simply resent after a failure.

import type * as vscode from 'vscode'
import { clipSummary, type RunEventInput, type RunEventType } from '@sdlc/contracts'
import { PlatformError, type PlatformClient } from '../platformClient'

const BATCH_MS = 1_000
const MAX_QUEUE = 2_000
/** Consecutive failed sends before the queue is dropped (while the run lasts / after it was closed). */
const MAX_FAILURES = 20
const MAX_FAILURES_AFTER_CLOSE = 4
const MAX_BACKOFF_MS = 60_000

export interface ActivityEvent {
  type: RunEventType
  stepId?: string | null
  agentType?: string | null
  agentName?: string | null
  skill?: string | null
  tool?: string | null
  path?: string | null
  summary?: string | null
  data?: Record<string, unknown>
}

export class ActivityReporter {
  private seq: number
  private queue: RunEventInput[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private sending: Promise<void> | undefined
  private closed = false
  private failures = 0

  constructor(
    private readonly projectKey: string,
    private readonly runId: string,
    private readonly client: () => Pick<PlatformClient, 'reportRunEvents'> | undefined,
    private readonly state: vscode.Memento,
    private readonly log: (m: string) => void,
    /** The batching interval; backoff after failures scales with it (tests shorten it). */
    private readonly batchMs = BATCH_MS,
  ) {
    this.seq = state.get<number>(this.key(), -1) + 1
  }

  private key(): string {
    return `sdlcGovernance.runEventSeq.${this.runId}`
  }

  add(e: ActivityEvent): void {
    if (this.closed) return
    const event: RunEventInput = {
      seq: this.seq++,
      at: new Date().toISOString(),
      type: e.type,
      stepId: e.stepId ?? null,
      agentType: e.agentType?.slice(0, 200) ?? null,
      agentName: e.agentName?.slice(0, 200) ?? null,
      skill: e.skill?.slice(0, 200) ?? null,
      tool: e.tool?.slice(0, 200) ?? null,
      path: e.path?.slice(0, 1_000) ?? null,
      summary: e.summary ? clipSummary(e.summary) : null,
      data: e.data ?? {},
    }
    void this.state.update(this.key(), event.seq)
    this.queue.push(event)
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE)
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.batchMs)
  }

  async flush(): Promise<void> {
    this.timer = undefined
    if (this.sending) {
      await this.sending
      if (this.queue.length) this.timer = setTimeout(() => void this.flush(), this.batchMs)
      return
    }
    const client = this.client()
    if (!client || this.queue.length === 0) return
    const batch = this.queue.slice(0, 200)
    this.sending = client
      .reportRunEvents(this.projectKey, this.runId, { events: batch })
      .then(() => {
        this.queue.splice(0, batch.length)
        this.failures = 0
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        const status = err instanceof PlatformError ? err.status : undefined
        if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          // The platform refused this batch (the run ended, a bad event): resending it would only fail again and hold
          // up everything after it, so drop it.
          this.log(`Dropped ${batch.length} activity event(s) of run ${this.runId} the platform refused: ${message}`)
          this.queue.splice(0, batch.length)
          return
        }
        this.failures++
        this.log(`Could not report activity of run ${this.runId} (attempt ${this.failures}): ${message}`)
        if (this.failures >= (this.closed ? MAX_FAILURES_AFTER_CLOSE : MAX_FAILURES)) {
          this.log(`Giving up on ${this.queue.length} activity event(s) of run ${this.runId}.`)
          this.queue = []
          this.failures = 0
        }
      })
      .finally(() => {
        this.sending = undefined
      })
    await this.sending
    if (this.queue.length && !this.timer) {
      // Back off after failures (never a tight loop, even once the run is closed).
      const delay = this.failures ? Math.min(MAX_BACKOFF_MS, this.batchMs * 3 * 2 ** (this.failures - 1)) : this.closed ? 0 : this.batchMs * 3
      this.timer = setTimeout(() => void this.flush(), delay)
    }
  }

  /** Send what is left and stop accepting events. */
  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.flush()
    this.closed = true
    void this.state.update(this.key(), undefined)
  }
}
