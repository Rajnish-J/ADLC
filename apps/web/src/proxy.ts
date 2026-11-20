// Next.js Proxy (formerly Middleware): runs before every page request. A visitor with no session cookie is sent
// straight to /login (with returnTo) instead of seeing the app frame flash before the first API call fails.
//
// This is the optimistic check Next.js recommends — the cookie's presence only. The real check happens on every
// data call: the /api/v1 proxy decrypts and renews the session, and the platform API verifies the Entra token. So
// /login is never redirected away from (a stale cookie would otherwise loop), and /api/* is left to its handlers.

import { NextResponse, type NextRequest } from 'next/server'
import { DEV_USER_COOKIE } from '@/server/apiConfig'
import { AUTH_MODE, SESSION_COOKIE } from '@/server/authConfig'

function hasSession(req: NextRequest): boolean {
  return AUTH_MODE === 'entra' ? req.cookies.has(`${SESSION_COOKIE}.0`) : req.cookies.has(DEV_USER_COOKIE)
}

export function proxy(req: NextRequest): NextResponse {
  if (hasSession(req)) return NextResponse.next()

  const login = new URL('/login', req.url)
  const returnTo = `${req.nextUrl.pathname}${req.nextUrl.search}`
  if (returnTo !== '/') login.searchParams.set('returnTo', returnTo)
  return NextResponse.redirect(login)
}

export const config = {
  matcher: [
    // Every page except the sign-in page; not API routes (they answer 401 themselves), Next's assets, the copied
    // Monaco editor, or any file with an extension (icon.svg, …).
    '/((?!api/|_next/static|_next/image|monaco/|login$|login/|.*\\.[A-Za-z0-9]+$).*)',
  ],
}
