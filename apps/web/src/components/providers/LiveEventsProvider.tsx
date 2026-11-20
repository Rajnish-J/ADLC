'use client'

// One Server-Sent Events connection per tab (through the /api/v1 proxy), shared by every component that
// wants live updates. Events carry ids only; subscribers refetch what changed.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { PLATFORM_EVENT, PlatformEventSchema, type PlatformEvent } from '@sdlc/contracts'

type Listener = (event: PlatformEvent) => void

interface LiveEventsValue {
  connected: boolean
  subscribe: (listener: Listener) => () => void
}

const LiveEventsContext = createContext<LiveEventsValue>({ connected: false, subscribe: () => () => undefined })

export function LiveEventsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const listeners = useRef(new Set<Listener>())
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const source = new EventSource('/api/v1/events')
    source.addEventListener(PLATFORM_EVENT, (message) => {
      let payload: object | null = null
      try {
        payload = JSON.parse((message as MessageEvent<string>).data)
      } catch {
        return
      }
      const parsed = PlatformEventSchema.safeParse(payload)
      if (!parsed.success) return
      if (parsed.data.type === 'ready') {
        setConnected(true)
        return
      }
      for (const listener of listeners.current) listener(parsed.data)
    })
    // EventSource reconnects by itself; show the indicator as offline meanwhile.
    source.onerror = () => setConnected(false)
    return () => {
      source.close()
      setConnected(false)
    }
  }, [enabled])

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  return <LiveEventsContext.Provider value={{ connected, subscribe }}>{children}</LiveEventsContext.Provider>
}

export function useLiveConnection(): boolean {
  return useContext(LiveEventsContext).connected
}

/** Call `handler` for every live event (the latest handler is always used; no re-subscribing per render). */
export function useLiveEvents(handler: Listener): void {
  const { subscribe } = useContext(LiveEventsContext)
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(() => subscribe((event) => latest.current(event)), [subscribe])
}
