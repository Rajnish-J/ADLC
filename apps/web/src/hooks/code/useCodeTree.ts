'use client'

// The file explorer's data: folders load lazily when expanded, and every loaded folder is refreshed when the branch
// changes on the server (a sync, a commit, a re-index) — so the tree never shows a stale listing.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TreeEntry } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { useLiveEvents } from '@/components/providers/LiveEventsProvider'
import { repoChanged } from '@/hooks/common/liveFilters'
import { listTree } from '@/service/code.service'

export interface CodeTree {
  /** Loaded folders: path ('' = root) → entries. */
  folders: Map<string, TreeEntry[]>
  loading: Set<string>
  error: AppError | null
  load: (dir: string) => Promise<void>
  /** Reload every folder loaded so far (e.g. after saving a draft, to refresh the M markers). */
  refresh: () => Promise<void>
}

export function useCodeTree(key: string, branch: string, enabled: boolean): CodeTree {
  const [folders, setFolders] = useState<Map<string, TreeEntry[]>>(new Map())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<AppError | null>(null)
  const loaded = useRef<Set<string>>(new Set())

  const load = useCallback(
    async (dir: string) => {
      setLoading((s) => new Set(s).add(dir))
      try {
        const entries = await listTree(key, branch, dir)
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
    [key, branch],
  )

  const refresh = useCallback(async () => {
    await Promise.all([...loaded.current].map((d) => load(d)))
  }, [load])

  // A new branch starts from its root.
  useEffect(() => {
    loaded.current = new Set()
    setFolders(new Map())
    setError(null)
    if (enabled) void load('')
  }, [load, enabled])

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const relevant = repoChanged(key, branch)
  useLiveEvents((e) => {
    if (!enabled || !relevant(e)) return
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => void refresh(), 250)
  })

  return { folders, loading, error, load, refresh }
}
