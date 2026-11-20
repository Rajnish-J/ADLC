// In-process event bus feeding the SSE stream. One API instance for now; with several instances this becomes
// Postgres LISTEN/NOTIFY carrying the same id-only events (see the platform plan).

import { EventEmitter } from 'events'
import type { PlatformEvent } from '@sdlc/contracts'

export class EventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    // One listener per open SSE connection.
    this.emitter.setMaxListeners(0)
  }

  publish(event: PlatformEvent): void {
    this.emitter.emit('event', event)
  }

  subscribe(listener: (event: PlatformEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}
