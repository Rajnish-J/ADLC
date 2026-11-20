'use client'

// Who is signed in. Loads /me once; any 401 sends the user to the sign-in page, which brings them back here after.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import type { Me } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { getMe, signOut as signOutRequest } from '@/service/session.service'

interface SessionValue {
  me: Me | null
  loading: boolean
  signOut: () => Promise<void>
}

const SessionContext = createContext<SessionValue>({ me: null, loading: true, signOut: async () => undefined })

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const onLoginPage = pathname === '/login'
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (onLoginPage) {
      setMe(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    getMe()
      .then((value) => {
        if (!cancelled) setMe(value)
      })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof AppError && err.status === 401) {
          const returnTo = `${window.location.pathname}${window.location.search}`
          router.replace(returnTo === '/' ? '/login' : `/login?${new URLSearchParams({ returnTo }).toString()}`)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [onLoginPage, router])

  const signOut = useCallback(async () => {
    await signOutRequest()
    setMe(null)
    router.replace('/login')
  }, [router])

  return <SessionContext.Provider value={{ me, loading, signOut }}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  return useContext(SessionContext)
}
