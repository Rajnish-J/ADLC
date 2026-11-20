'use client'

// The repositories each Git connection's token can reach, fetched once per connection while the new-project
// dialog is open (listing them calls GitHub / Azure DevOps, so they are not refetched on every change).

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccessibleRepo } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { listConnectionRepos } from '@/service/connections.service'

export interface ConnectionRepos {
  loading: boolean
  repos: AccessibleRepo[]
  truncated: boolean
  error: AppError | null
}

export function useConnectionRepos(connectionIds: string[]): {
  byConnection: Record<string, ConnectionRepos>
  retry: (id: string) => void
} {
  const [byConnection, setByConnection] = useState<Record<string, ConnectionRepos>>({})
  const requested = useRef<Set<string>>(new Set())

  const fetchOne = useCallback((id: string) => {
    requested.current.add(id)
    setByConnection((m) => ({ ...m, [id]: { loading: true, repos: m[id]?.repos ?? [], truncated: false, error: null } }))
    listConnectionRepos(id)
      .then((r) => setByConnection((m) => ({ ...m, [id]: { loading: false, repos: r.repos, truncated: r.truncated, error: null } })))
      .catch((err) =>
        setByConnection((m) => ({
          ...m,
          [id]: { loading: false, repos: [], truncated: false, error: err instanceof AppError ? err : new AppError('Could not list the repositories.') },
        })),
      )
  }, [])

  const key = connectionIds.join(',')
  useEffect(() => {
    for (const id of key ? key.split(',') : []) if (!requested.current.has(id)) fetchOne(id)
  }, [key, fetchOne])

  return { byConnection, retry: fetchOne }
}
