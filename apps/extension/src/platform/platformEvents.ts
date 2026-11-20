// Live updates from the platform API over Server-Sent Events, read with fetch streaming (the extension host has
// no EventSource). Reconnects with backoff until disposed. Framework-free (no `vscode`).

import { PLATFORM_EVENT, PlatformEventSchema, type PlatformEvent } from '@sdlc/contracts'
import type { PlatformClient } from './platformClient'

export interface PlatformEventHandlers {
  onEvent: (event: PlatformEvent) => void
  /** Called with true once the stream is open, false whenever it drops. */
  onStatus?: (connected: boolean) => void
}

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

/** Parse SSE frames out of `buffer`; returns the platform events found and the unconsumed remainder. */
export function parseSseFrames(buffer: string): { events: PlatformEvent[]; rest: string } {
  const events: PlatformEvent[] = []
  let rest = buffer.replace(/\r\n/g, '\n')
  let end: number
  while ((end = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, end)
    rest = rest.slice(end + 2)
    let name = 'message'
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (name !== PLATFORM_EVENT || data.length === 0) continue
    try {
      const parsed = PlatformEventSchema.safeParse(JSON.parse(data.join('\n')))
      if (parsed.success) events.push(parsed.data)
    } catch {
      /* malformed frame — skip */
    }
  }
  return { events, rest }
}

export function subscribePlatformEvents(client: PlatformClient, handlers: PlatformEventHandlers): { dispose(): void } {
  let disposed = false
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let backoff = MIN_BACKOFF_MS

  const scheduleReconnect = (): void => {
    if (disposed) return
    timer = setTimeout(() => void connect(), backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }

  const connect = async (): Promise<void> => {
    if (disposed) return
    controller = new AbortController()
    try {
      const res = await fetch(client.eventsUrl, { headers: client.headers({ accept: 'text/event-stream' }), signal: controller.signal })
      if (!res.ok || !res.body) throw new Error(`events stream returned ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { events, rest } = parseSseFrames(buffer)
        buffer = rest
        for (const event of events) {
          if (event.type === 'ready') {
            backoff = MIN_BACKOFF_MS
            handlers.onStatus?.(true)
          }
          // `ready` too: after a (re)connect, listeners catch up on what they missed (runs requested from the web
          // while this window was offline, changes to refresh).
          handlers.onEvent(event)
        }
      }
    } catch {
      /* dropped or refused — fall through to reconnect */
    }
    handlers.onStatus?.(false)
    scheduleReconnect()
  }

  void connect()
  return {
    dispose: () => {
      disposed = true
      if (timer) clearTimeout(timer)
      controller?.abort()
    },
  }
}
