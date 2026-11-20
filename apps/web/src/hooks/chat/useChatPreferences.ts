'use client'

// The composer's choices — assistant, project, model, tool mode, switched-off tools, read-aloud — remembered per
// browser. Storage can be unavailable (private windows, blocked site data); the chat then just uses defaults.

import { useCallback, useEffect, useState } from 'react'
import type { ChatToolMode } from '@sdlc/contracts'

export interface ChatPreferences {
  agent: string
  projectKey: string | null
  model: string | null
  toolMode: ChatToolMode
  /** Per assistant: tools the user switched off in the Tools popover. */
  disabledTools: Record<string, string[]>
  readAloud: boolean
}

const KEY = 'sdlc.chat.preferences'
const DEFAULTS: ChatPreferences = { agent: 'default', projectKey: null, model: null, toolMode: 'auto', disabledTools: {}, readAloud: false }

function read(): ChatPreferences {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ChatPreferences>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

function write(value: ChatPreferences): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    // Not persisted — fine, it still applies for this visit.
  }
}

/** `initial` (e.g. from the URL: ?agent=workflows&project=PAY) wins over what was remembered. */
export function useChatPreferences(initial: Partial<Pick<ChatPreferences, 'agent' | 'projectKey'>>) {
  const [prefs, setPrefs] = useState<ChatPreferences>(() => ({ ...DEFAULTS, ...strip(initial) }))

  useEffect(() => {
    setPrefs({ ...read(), ...strip(initial) })
    // Read once on mount; the URL values only seed the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = useCallback((patch: Partial<ChatPreferences>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch }
      write(next)
      return next
    })
  }, [])

  return { prefs, update }
}

function strip(v: Partial<Pick<ChatPreferences, 'agent' | 'projectKey'>>): Partial<ChatPreferences> {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== ''))
}
