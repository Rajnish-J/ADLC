'use client'

// The run monitor's state, app-wide: whether the dock is open and which run it follows. It lives in the app shell —
// above every page — so following a run survives moving to the Code page (or anywhere else); runs themselves live on
// the server and never depend on a page being open. It opens by itself when one of your runs starts or hands a step
// to VS Code.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLiveEvents } from '@/components/providers/LiveEventsProvider'
import { useSession } from '@/components/providers/SessionProvider'

const OPEN_KEY = 'sdlc.runMonitor.open'

export interface RunRef {
  projectKey: string
  runId: string
}

interface RunMonitorValue {
  open: boolean
  setOpen: (open: boolean) => void
  /** The run the dock shows; null = the newest active one. */
  followed: RunRef | null
  /** Open the dock on a run. */
  follow: (run: RunRef) => void
}

const RunMonitorContext = createContext<RunMonitorValue>({ open: false, setOpen: () => undefined, followed: null, follow: () => undefined })

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    /* private window: the dock just doesn't remember */
  }
}

export function RunMonitorProvider({ children }: { children: ReactNode }) {
  const { me } = useSession()
  const [open, setOpenState] = useState(false)
  const [followed, setFollowed] = useState<RunRef | null>(null)

  useEffect(() => setOpenState(readOpen()), [])

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    writeOpen(next)
  }, [])

  const follow = useCallback(
    (run: RunRef) => {
      setFollowed(run)
      setOpen(true)
    },
    [setOpen],
  )

  // One of my runs started, or reached VS Code: follow it.
  useLiveEvents((e) => {
    if ((e.type === 'run.requested' || e.type === 'run.step') && e.targetUserId === me?.user.id) {
      if (e.type === 'run.requested' || followed?.runId !== e.runId) follow({ projectKey: e.projectKey, runId: e.runId })
    }
  })

  const value = useMemo(() => ({ open, setOpen, followed, follow }), [open, setOpen, followed, follow])
  return <RunMonitorContext.Provider value={value}>{children}</RunMonitorContext.Provider>
}

export function useRunMonitor(): RunMonitorValue {
  return useContext(RunMonitorContext)
}
