import { z } from 'zod'
import { MeSchema, UserSchema, type Me, type User } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { AuthInfoSchema, type AuthInfo } from '@/types/session/session.types'
import { apiRequest } from './http'

/** How this deployment signs people in — Microsoft (Entra ID) or the local-development picker. */
export async function getAuthInfo(): Promise<AuthInfo> {
  let res: Response
  try {
    res = await fetch('/api/session', { cache: 'no-store' })
  } catch (err) {
    throw new AppError('Cannot reach the server', err instanceof Error ? err.message : undefined)
  }
  if (!res.ok) throw new AppError('Cannot load sign-in options', `Status: ${res.status}`, res.status)
  const parsed = AuthInfoSchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) throw new AppError('Unexpected response from the server', parsed.error.issues[0]?.message, res.status)
  return parsed.data
}

/** Leave for Microsoft's sign-in page; the server brings the browser back to `returnTo` once signed in. */
export function startMicrosoftSignIn(returnTo?: string | null): void {
  const query = returnTo ? `?${new URLSearchParams({ returnTo }).toString()}` : ''
  window.location.assign(`/api/auth/login${query}`)
}

/** Seeded users for the local dev sign-in picker. */
export function getDevUsers(): Promise<User[]> {
  return apiRequest('/dev/users', z.array(UserSchema))
}

export function getMe(): Promise<Me> {
  return apiRequest('/me', MeSchema)
}

/** Org directory, for adding project members. */
export function listUsers(): Promise<User[]> {
  return apiRequest('/users', z.array(UserSchema))
}

async function session(method: 'POST' | 'DELETE', email?: string): Promise<void> {
  try {
    const res = await fetch('/api/session', {
      method,
      headers: email ? { 'content-type': 'application/json' } : undefined,
      body: email ? JSON.stringify({ email }) : undefined,
    })
    if (!res.ok) throw new AppError('Sign-in failed', `Status: ${res.status}`, res.status)
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError('Cannot reach the server')
  }
}

export const signIn = (email: string): Promise<void> => session('POST', email)
export const signOut = (): Promise<void> => session('DELETE')
