'use client'

// Load one API resource, keep it fresh with live events, and expose loading/error/reload. A 401 sends the
// user to sign in. Live reloads are coalesced so a burst of events triggers one refetch.

import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import { useRouter } from 'next/navigation'
import type { PlatformEvent } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { useLiveEvents } from '@/components/providers/LiveEventsProvider'

export interface ApiResource<T> {
  data: T | null
  error: AppError | null
  loading: boolean
  reload: () => Promise<void>
  /** Replace the data locally (e.g. with a mutation's response) without refetching. */
  setData: (value: T) => void
}

export function useApiResource<T>(
  load: () => Promise<T>,
  deps: DependencyList,
  isRelevant?: (event: PlatformEvent) => boolean,
): ApiResource<T> {
  const router = useRouter()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [loading, setLoading] = useState(true)

  // `deps` lists what `load` closes over (e.g. the project key), so a new key loads afresh.
  const stableLoad = useCallback(load, deps)

  const reload = useCallback(async () => {
    try {
      setData(await stableLoad())
      setError(null)
    } catch (err) {
      const appError = err instanceof AppError ? err : new AppError('Something went wrong')
      if (appError.status === 401) router.replace('/login')
      setError(appError)
    } finally {
      setLoading(false)
    }
  }, [stableLoad, router])

  useEffect(() => {
    setLoading(true)
    void reload()
  }, [reload])

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLiveEvents((event) => {
    if (isRelevant && !isRelevant(event)) return
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => void reload(), 150)
  })
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    [],
  )

  return { data, error, loading, reload, setData }
}
