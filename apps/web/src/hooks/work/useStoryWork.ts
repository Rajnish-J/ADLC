'use client'

import { useCallback, useState } from 'react'
import type { Patch, StoryWork } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { storyWorkChanged } from '@/hooks/common/liveFilters'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getCommitDiff, getStoryWork, getWorkspaceDiff } from '@/service/work.service'

/** Code activity on a story. Refreshes live as developers edit, commit and run agents in VS Code. */
export function useStoryWork(key: string, number: number): ApiResource<StoryWork> {
  return useApiResource(() => getStoryWork(key, number), [key, number], storyWorkChanged(key, number))
}

export type DiffTarget = { kind: 'commit'; sha: string } | { kind: 'workspace'; userId: string }

export interface DiffResource {
  patch: Patch | null
  loading: boolean
  error: string | null
  load: (target: DiffTarget) => Promise<void>
}

/** Fetch a diff on demand (diffs are never part of the story's work listing). */
export function useDiff(key: string, number: number): DiffResource {
  const [patch, setPatch] = useState<Patch | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    async (target: DiffTarget) => {
      setLoading(true)
      setError(null)
      setPatch(null)
      try {
        setPatch(target.kind === 'commit' ? await getCommitDiff(key, number, target.sha) : await getWorkspaceDiff(key, number, target.userId))
      } catch (err) {
        setError(err instanceof AppError ? err.message : 'Could not load the diff')
      } finally {
        setLoading(false)
      }
    },
    [key, number],
  )
  return { patch, loading, error, load }
}
