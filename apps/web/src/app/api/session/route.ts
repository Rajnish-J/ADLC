// The browser's session. GET says how to sign in (Microsoft or the local-development picker); POST is the dev
// sign-in (remembers which seeded user you are in an httpOnly cookie — the API refuses dev mode in production);
// DELETE signs out of either. Microsoft sign-in itself runs through /api/auth/login and /api/auth/callback.

import { cookies } from 'next/headers'
import { z } from 'zod'
import { DEV_USER_COOKIE } from '@/server/apiConfig'
import { AUTH_MODE } from '@/server/authConfig'
import { clearSession } from '@/server/entraSession'
import type { AuthInfo } from '@/types/session/session.types'

export const dynamic = 'force-dynamic'

const SignInSchema = z.object({ email: z.string().trim().email() })

export async function GET(): Promise<Response> {
  return Response.json({ mode: AUTH_MODE } satisfies AuthInfo)
}

export async function POST(req: Request): Promise<Response> {
  if (AUTH_MODE !== 'dev') {
    return Response.json({ error: 'forbidden', message: 'Sign in with Microsoft.' }, { status: 403 })
  }
  const parsed = SignInSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'bad_request', message: 'A user email is required.' }, { status: 400 })
  }
  ;(await cookies()).set(DEV_USER_COOKIE, parsed.data.email, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return Response.json({ ok: true })
}

export async function DELETE(): Promise<Response> {
  ;(await cookies()).delete(DEV_USER_COOKIE)
  if (AUTH_MODE === 'entra') await clearSession()
  return Response.json({ ok: true })
}
