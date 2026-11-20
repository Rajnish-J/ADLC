// The signed-in user's Entra session (AUTH_MODE=entra): tokens in an encrypted cookie, renewed shortly before the
// access token expires. Only route handlers use this — the access token never reaches browser JavaScript.

import { SESSION_COOKIE } from './authConfig'
import { deleteSealedCookie, readSealedCookie, writeSealedCookie } from './sealedCookie'
import { EntraTokensSchema, refreshTokens, SignInFlowSchema, type EntraTokens, type SignInFlow } from './msal'

const FLOW_COOKIE = 'sdlc_signin'
const FLOW_COOKIE_PATH = '/api/auth'

/** The cookie outlives the access token: the refresh token keeps the session going (Entra may still end it sooner). */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
/** Time allowed to finish signing in at Microsoft. */
const FLOW_MAX_AGE_SECONDS = 60 * 10
/** Renew this long before expiry, so a token never expires between here and the API. */
const REFRESH_MARGIN_MS = 5 * 60_000

/** Parallel requests near expiry share one refresh instead of each spending the refresh token. */
const refreshing = new Map<string, Promise<EntraTokens>>()

export async function saveSession(tokens: EntraTokens): Promise<void> {
  await writeSealedCookie(SESSION_COOKIE, tokens, { maxAgeSeconds: SESSION_MAX_AGE_SECONDS })
}

export async function clearSession(): Promise<void> {
  await deleteSealedCookie(SESSION_COOKIE)
}

/** A valid access token for the platform API, renewing it when needed; null when the user must sign in again. */
export async function currentAccessToken(): Promise<string | null> {
  const session = await readSealedCookie(SESSION_COOKIE, EntraTokensSchema)
  if (!session) return null
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken

  let pending = refreshing.get(session.refreshToken)
  if (!pending) {
    pending = refreshTokens(session.refreshToken).finally(() => refreshing.delete(session.refreshToken))
    refreshing.set(session.refreshToken, pending)
  }
  try {
    const renewed = await pending
    await saveSession(renewed)
    return renewed.accessToken
  } catch (err) {
    console.warn('[auth] Could not renew the Entra session; the user must sign in again.', err instanceof Error ? err.message : err)
    await clearSession()
    return null
  }
}

export async function saveSignInFlow(flow: SignInFlow): Promise<void> {
  await writeSealedCookie(FLOW_COOKIE, flow, { maxAgeSeconds: FLOW_MAX_AGE_SECONDS, path: FLOW_COOKIE_PATH })
}

/** The in-flight sign-in, consumed: a callback can be completed once. */
export async function takeSignInFlow(): Promise<SignInFlow | undefined> {
  const flow = await readSealedCookie(FLOW_COOKIE, SignInFlowSchema)
  await deleteSealedCookie(FLOW_COOKIE, FLOW_COOKIE_PATH)
  return flow
}

/** A same-app path to land on after signing in; anything else (other origins, `//evil`, the sign-in page) → `/`. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/api/')) return '/'
  return value
}
