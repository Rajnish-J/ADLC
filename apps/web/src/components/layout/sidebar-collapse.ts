'use client'

// "Collapse all" for the sidebar: one signal every collapsible group listens to (Settings, the project group, the
// project's Settings), so the footer button can close them all without lifting their state into one place.

import { useEffect, useRef } from 'react'

const COLLAPSE_ALL = 'sdlc:sidebar-collapse-all'

export function collapseAllSidebarGroups(): void {
  window.dispatchEvent(new Event(COLLAPSE_ALL))
}

/** Calls `close` whenever "Collapse all" is clicked. */
export function useCollapseAll(close: () => void): void {
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    const onCollapse = () => latest.current()
    window.addEventListener(COLLAPSE_ALL, onCollapse)
    return () => window.removeEventListener(COLLAPSE_ALL, onCollapse)
  }, [])
}
