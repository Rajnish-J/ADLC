// Microsoft Entra ID access-token verification (AUTH_MODE=entra). The web app signs the user in with MSAL and
// forwards the access token it got for this API; here we check the signature against the tenant's published keys,
// the issuer (v1 or v2 endpoint — which one depends on the app manifest's accessTokenAcceptedVersion), the
// audience, the tenant and that it is a delegated user token (has `scp`), not an app-only one.

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import { unauthorized } from './http'

/** Who the token says the caller is. Identity is (tenantId, oid) — the email can change, the oid never does. */
export interface EntraIdentity {
  oid: string
  tenantId: string
  email: string
  displayName: string
}

export type EntraTokenVerifier = (token: string) => Promise<EntraIdentity>

export interface EntraVerifierOptions {
  tenantId: string
  clientId: string
  /** Audiences accepted besides `<clientId>` and `api://<clientId>`. */
  extraAudiences?: string[]
  /** Signing-key source. Defaults to the tenant's JWKS endpoint (cached and rotated by jose); tests inject a local key. */
  keys?: JWTVerifyGetKey
}

const EntraClaimsSchema = z.object({
  oid: z.string().uuid(),
  tid: z.string().uuid(),
  /** Delegated scopes. App-only (client-credential) tokens carry `roles` instead and are refused. */
  scp: z.string().min(1),
  name: z.string().optional(),
  /** v2 tokens */
  preferred_username: z.string().optional(),
  /** v1 tokens */
  upn: z.string().optional(),
  unique_name: z.string().optional(),
  email: z.string().optional(),
})

/** Small allowance for clock drift between Entra and this server. */
const CLOCK_TOLERANCE_SECONDS = 60

export function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1]
}

export function createEntraVerifier(options: EntraVerifierOptions): EntraTokenVerifier {
  const tenantId = options.tenantId.toLowerCase()
  const keys =
    options.keys ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`))
  const issuer = [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`]
  const audience = [options.clientId, `api://${options.clientId}`, ...(options.extraAudiences ?? [])]

  return async (token) => {
    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
    try {
      ;({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience,
        algorithms: ['RS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }))
    } catch (err) {
      throw unauthorized(
        err instanceof errors.JWTExpired ? 'Your session has expired. Sign in again.' : 'The access token is not valid for this API.',
      )
    }

    const claims = EntraClaimsSchema.safeParse(payload)
    if (!claims.success) throw unauthorized('The access token is not a delegated user token for this API.')
    const c = claims.data
    if (c.tid.toLowerCase() !== tenantId) throw unauthorized('The access token was issued by another tenant.')

    const email = (c.preferred_username ?? c.upn ?? c.unique_name ?? c.email)?.trim()
    if (!email) throw unauthorized('The access token carries no user name.')
    return { oid: c.oid.toLowerCase(), tenantId, email, displayName: c.name?.trim() || email }
  }
}
