// Sign-in configuration from the environment. Imported only by route handlers (server code) — the client secret and
// session key never reach the browser.

import { z } from 'zod'
import { AuthModeSchema, type AuthMode } from '@/types/session/session.types'

const AuthEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_MODE: AuthModeSchema.default('dev'),
  /** Directory (tenant) id of the Microsoft Entra ID tenant people sign in with. */
  ENTRA_TENANT_ID: z.string().trim().uuid('ENTRA_TENANT_ID must be the directory (tenant) id GUID.').optional(),
  /** Application (client) id of the app registration. */
  ENTRA_CLIENT_ID: z.string().trim().uuid('ENTRA_CLIENT_ID must be the application (client) id GUID.').optional(),
  /** Client secret of the app registration (Certificates & secrets). */
  ENTRA_CLIENT_SECRET: z.string().trim().min(1).optional(),
  /** Delegated scope requested for the platform API. Default: `api://<ENTRA_CLIENT_ID>/access_as_user`. */
  ENTRA_API_SCOPE: z.string().trim().min(1).optional(),
  /** Override when the app runs behind a proxy: the public callback URL registered in Entra. */
  ENTRA_REDIRECT_URI: z.string().trim().url().optional(),
  /** Encrypts the session cookie. 32+ random bytes — `openssl rand -base64 32`. Required in production. */
  AUTH_SESSION_SECRET: z.string().trim().min(32, 'AUTH_SESSION_SECRET must be at least 32 characters.').optional(),
})

export interface EntraConfig {
  tenantId: string
  clientId: string
  clientSecret: string
  apiScope: string
  redirectUri: string | undefined
  sessionSecret: string
  secureCookies: boolean
}

/** Development only — a well-known key, so sessions survive restarts without any setup. Refused in production. */
const DEV_SESSION_SECRET = 'sdlc-local-development-session-secret-not-for-production'

export const AUTH_MODE: AuthMode = AuthModeSchema.catch('dev').parse(process.env.AUTH_MODE)

/** The encrypted Entra session cookie (split into `<name>.0`, `<name>.1`, … — see sealedCookie.ts). */
export const SESSION_COOKIE = 'sdlc_session'

let cached: EntraConfig | undefined

/** The Entra settings, validated on first use. Throws with a message naming what is missing. */
export function entraConfig(): EntraConfig {
  if (cached) return cached
  const env = AuthEnvSchema.parse(process.env)
  const missing = (['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET'] as const).filter((k) => !env[k])
  if (missing.length > 0) throw new Error(`Microsoft sign-in is not configured: set ${missing.join(', ')}.`)
  if (env.NODE_ENV === 'production' && !env.AUTH_SESSION_SECRET) {
    throw new Error('AUTH_SESSION_SECRET is required in production (32 random bytes, base64) — it encrypts the session cookie.')
  }
  const clientId = env.ENTRA_CLIENT_ID ?? ''
  cached = {
    tenantId: env.ENTRA_TENANT_ID ?? '',
    clientId,
    clientSecret: env.ENTRA_CLIENT_SECRET ?? '',
    apiScope: env.ENTRA_API_SCOPE ?? `api://${clientId}/access_as_user`,
    redirectUri: env.ENTRA_REDIRECT_URI,
    sessionSecret: env.AUTH_SESSION_SECRET ?? DEV_SESSION_SECRET,
    secureCookies: env.NODE_ENV === 'production',
  }
  return cached
}

/** Where this app is reached from the browser: the registered callback's origin when set, else the request's. */
export function publicOrigin(req: Request): string {
  const configured = process.env.ENTRA_REDIRECT_URI
  return configured ? new URL(configured).origin : new URL(req.url).origin
}

export function callbackUrl(req: Request): string {
  return entraConfig().redirectUri ?? `${publicOrigin(req)}/api/auth/callback`
}
