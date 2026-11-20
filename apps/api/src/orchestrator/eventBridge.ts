// Live events from the orchestrator service. It writes them with `pg_notify('sdlc_events', …)` inside the
// transaction that made the change; this dedicated connection LISTENs and republishes each one on the gateway's
// SSE bus, so the web app and the extension see orchestrator changes exactly like the gateway's own. Reconnects
// with backoff; a malformed payload is logged and dropped.

import type { FastifyBaseLogger } from 'fastify'
import { Client } from 'pg'
import { PlatformEventSchema } from '@sdlc/contracts'
import type { EventBus } from '../events'

export const EVENTS_CHANNEL = 'sdlc_events'

export class OrchestratorEventBridge {
  private client: Client | null = null
  private stopped = false
  private retryMs = 1_000
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly databaseUrl: string,
    private readonly bus: EventBus,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    const c = this.client
    this.client = null
    await c?.end().catch(() => undefined)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const client = new Client({ connectionString: this.databaseUrl })
    client.on('notification', (msg) => {
      if (msg.channel !== EVENTS_CHANNEL || !msg.payload) return
      let raw: unknown
      try {
        raw = JSON.parse(msg.payload)
      } catch {
        this.log.warn('Dropped an orchestrator event that is not JSON')
        return
      }
      const parsed = PlatformEventSchema.safeParse(raw)
      if (!parsed.success) {
        this.log.warn({ issues: parsed.error.issues.slice(0, 3) }, 'Dropped an orchestrator event with an unknown shape')
        return
      }
      this.bus.publish(parsed.data)
    })
    client.on('error', (err) => {
      this.log.warn({ err }, 'Orchestrator event connection failed; reconnecting')
      this.reconnect(client)
    })
    client.on('end', () => this.reconnect(client))
    try {
      await client.connect()
      await client.query(`LISTEN ${EVENTS_CHANNEL}`)
      this.client = client
      this.retryMs = 1_000
    } catch (err) {
      this.log.warn({ err }, 'Could not listen for orchestrator events; retrying')
      this.reconnect(client)
    }
  }

  private reconnect(client: Client): void {
    if (this.stopped || (this.client && this.client !== client) || this.timer) return
    this.client = null
    client.end().catch(() => undefined)
    const delay = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, 30_000)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, delay)
    this.timer.unref()
  }
}
