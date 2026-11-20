import { z } from 'zod'

/** How people sign in. Must match the API's AUTH_MODE — both read it from the repository root's .env. */
export const AuthModeSchema = z.enum(['dev', 'entra'])
export type AuthMode = z.infer<typeof AuthModeSchema>

/** GET /api/session — what the sign-in page needs to know before it renders. */
export const AuthInfoSchema = z.object({ mode: AuthModeSchema })
export type AuthInfo = z.infer<typeof AuthInfoSchema>

/** Why a Microsoft sign-in came back to /login?error=… instead of into the app. */
export const SignInErrorSchema = z.enum(['cancelled', 'expired_request', 'signin_failed', 'not_configured'])
export type SignInError = z.infer<typeof SignInErrorSchema>
