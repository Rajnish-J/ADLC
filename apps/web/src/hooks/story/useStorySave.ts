'use client'

// Run one story mutation from the board or the drawer: show the result, toast what happened, and when the API
// answers 409 (someone else changed the story first) reload so the user sees the latest instead of a dead end.

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { Story } from '@sdlc/contracts'
import { AppError } from '@/appError'

export type SaveStory = (id: string, action: () => Promise<Story>, done?: string | ((story: Story) => string)) => Promise<boolean>

export interface StorySave {
  /** Which mutation is running (the `id` passed to `save`), or null. */
  busy: string | null
  save: SaveStory
}

export function useStorySave(onChange: (story: Story) => void, reload: () => Promise<void>): StorySave {
  const [busy, setBusy] = useState<string | null>(null)

  const save = useCallback<SaveStory>(
    async (id, action, done) => {
      setBusy(id)
      try {
        const story = await action()
        onChange(story)
        if (done) toast.success(typeof done === 'function' ? done(story) : done)
        return true
      } catch (err) {
        if (err instanceof AppError && err.status === 409) {
          toast.error(err.message, { description: 'Showing the latest version of the story.' })
          await reload()
        } else {
          toast.error(err instanceof AppError ? err.message : 'That did not work.')
        }
        return false
      } finally {
        setBusy(null)
      }
    },
    [onChange, reload],
  )

  return { busy, save }
}
