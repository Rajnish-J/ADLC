'use client'

// Data for a workflow run's branch on the Code page (the run's work as VS Code reported it — the branch is never
// pushed). Everything refreshes when VS Code reports the run's changes again (after each step, and at the end).

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformEvent, RunBranch, RunBranchDetail, RunBranchFileContent, TreeEntry } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { useLiveEvents } from '@/components/providers/LiveEventsProvider'
import { projectRunsChanged } from '@/hooks/common/liveFilters'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getRunBranch, getRunBranchFile, listRunBranches, listRunBranchTree } from '@/service/code.service'
import type { CodeTree } from './useCodeTree'

const runChanged = (key: string, runId: string) => (e: PlatformEvent) => e.type === 'work.changed' && e.projectKey === key && e.kind === 'run' && e.runId === runId

/** The project's run branches (for the branch picker). */
export function useRunBranches(key: string, enabled: boolean): ApiResource<RunBranch[]> {
  return useApiResource(() => (enabled ? listRunBranches(key) : Promise.resolve([])), [key, enabled], projectRunsChanged(key))
}

export function useRunBranchDetail(key: string, runId: string): ApiResource<RunBranchDetail> {
  return useApiResource(() => getRunBranch(key, runId), [key, runId], runChanged(key, runId))
}

export function useRunBranchFile(key: string, runId: string, path: string | null): ApiResource<RunBranchFileContent | null> {
  return useApiResource(() => (path ? getRunBranchFile(key, runId, path) : Promise.resolve(null)), [key, runId, path], runChanged(key, runId))
}

/** The run branch's explorer: folders load when expanded; every loaded folder reloads when the run reports again. */
export function useRunBranchTree(key: string, runId: string): CodeTree {
  const [folders, setFolders] = useState<Map<string, TreeEntry[]>>(new Map())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<AppError | null>(null)
  const loaded = useRef<Set<string>>(new Set())

  const load = useCallback(
    async (dir: string) => {
      setLoading((s) => new Set(s).add(dir))
      try {
        const entries = await listRunBranchTree(key, runId, dir)
        loaded.current.add(dir)
        setFolders((m) => new Map(m).set(dir, entries))
        setError(null)
      } catch (err) {
        setError(err instanceof AppError ? err : new AppError('Could not load the folder.'))
      } finally {
        setLoading((s) => {
          const next = new Set(s)
          next.delete(dir)
          return next
        })
      }
    },
    [key, runId],
  )

  const refresh = useCallback(async () => {
    await Promise.all([...loaded.current].map((d) => load(d)))
  }, [load])

  useEffect(() => {
    loaded.current = new Set()
    setFolders(new Map())
    void load('')
  }, [load])

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const relevant = runChanged(key, runId)
  useLiveEvents((e) => {
    if (!relevant(e)) return
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => void refresh(), 300)
  })

  return { folders, loading, error, load, refresh }
}
