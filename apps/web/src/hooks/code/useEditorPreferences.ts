'use client'

// Code editor preferences (Settings → Appearance), kept in this browser. Every open editor follows changes at once.

import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'

export const EditorPreferencesSchema = z.object({
  fontSize: z.number().int().min(10).max(24),
  wordWrap: z.boolean(),
  minimap: z.boolean(),
})
export type EditorPreferences = z.infer<typeof EditorPreferencesSchema>

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = { fontSize: 13, wordWrap: false, minimap: true }

const KEY = 'sdlc.editor.preferences'
const EVENT = 'sdlc:editor-preferences'

function read(): EditorPreferences {
  try {
    const raw = window.localStorage.getItem(KEY)
    const parsed = EditorPreferencesSchema.safeParse(raw ? JSON.parse(raw) : null)
    return parsed.success ? parsed.data : DEFAULT_EDITOR_PREFERENCES
  } catch {
    return DEFAULT_EDITOR_PREFERENCES
  }
}

export function useEditorPreferences(): [EditorPreferences, (patch: Partial<EditorPreferences>) => void] {
  const [prefs, setPrefs] = useState<EditorPreferences>(DEFAULT_EDITOR_PREFERENCES)

  useEffect(() => {
    setPrefs(read())
    const sync = (): void => setPrefs(read())
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const update = useCallback((patch: Partial<EditorPreferences>) => {
    const next = { ...read(), ...patch }
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* storage unavailable — keep it for this page only */
    }
    setPrefs(next)
    window.dispatchEvent(new Event(EVENT))
  }, [])

  return [prefs, update]
}
