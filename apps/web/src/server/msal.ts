// MSAL (confidential client) for the web app's Microsoft sign-in: the authorization-code flow with PKCE, and
// refreshing the API access token. A new client per call — MSAL's in-memory token cache must never be shared
// between users; each user's tokens live in their own encrypted session cookie instead.

import { ConfidentialClientApplication, CryptoProvider, type AuthenticationResult } from '@azure/msal-node'
import { z } from 'zod'
import { entraConfig } from './authConfig'

/** What the session keeps: an access token for the platform API and the refresh token that renews it. */
export const EntraTokensSchema = z.object({
  accessToken: z.string().min(1),
  /** Epoch milliseconds. */
  expiresAt: z.number().int(),
  refreshToken: z.string().min(1),
})
export type EntraTokens = z.infer<typeof EntraTokensSchema>

/** The in-flight sign-in, kept between the redirect to Microsoft and the callback. */
export const SignInFlowSchema = z.object({
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  returnTo: z.string(),
})
export type SignInFlow = z.infer<typeof SignInFlowSchema>

/** The part of MSAL's serialized cache we read: the refresh token it received. */
const SerializedCacheSchema = z.object({
  RefreshToken: z.record(z.object({ secret: z.string().min(1) })).optional(),
})

/** Assumed lifetime when Entra doesn't say (it always does; access tokens last 60–90 minutes). */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60_000

function createClient(): ConfidentialClientApplication {
  const config = entraConfig()
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientSecret: config.clientSecret,
    },
  })
}

/** The platform API's scope, plus `offline_access` for a refresh token (openid and profile are added by MSAL). */
function signInScopes(): string[] {
  return [entraConfig().apiScope, 'offline_access']
}

function toTokens(client: ConfidentialClientApplication, result: AuthenticationResult, previousRefreshToken?: string): EntraTokens {
  const cache = SerializedCacheSchema.parse(JSON.parse(client.getTokenCache().serialize()))
  const refreshToken = Object.values(cache.RefreshToken ?? {})[0]?.secret ?? previousRefreshToken
  if (!refreshToken) throw new Error('Entra returned no refresh token — is offline_access allowed for the app registration?')
  return {
    accessToken: result.accessToken,
    expiresAt: result.expiresOn?.getTime() ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
    refreshToken,
  }
}

/** Step 1: the Microsoft sign-in URL, and the state + PKCE verifier the callback must present. */
export async function beginSignIn(redirectUri: string, returnTo: string): Promise<{ url: string; flow: SignInFlow }> {
  const crypto = new CryptoProvider()
  const { verifier, challenge } = await crypto.generatePkceCodes()
  const state = crypto.createNewGuid()
  const url = await createClient().getAuthCodeUrl({
    scopes: signInScopes(),
    redirectUri,
    state,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    // Always offer the account picker, so "Sign out" → "Sign in" can switch accounts.
    prompt: 'select_account',
  })
  return { url, flow: { state, codeVerifier: verifier, returnTo } }
}

/** Step 2: redeem the authorization code from the callback for tokens. */
export async function completeSignIn(code: string, codeVerifier: string, redirectUri: string): Promise<EntraTokens> {
  const client = createClient()
  const result = await client.acquireTokenByCode({ code, codeVerifier, redirectUri, scopes: signInScopes() })
  return toTokens(client, result)
}

/** A fresh access token from the refresh token. Throws when Entra refuses it (revoked, expired, password reset, …). */
export async function refreshTokens(refreshToken: string): Promise<EntraTokens> {
  const client = createClient()
  const result = await client.acquireTokenByRefreshToken({ refreshToken, scopes: [entraConfig().apiScope], forceCache: true })
  if (!result) throw new Error('Entra returned no token for the refresh token.')
  return toTokens(client, result, refreshToken)
}
