// ClientSecretCredential fallback (documented, headless/CI path).
//
// This mirrors the analytics repo's proven orka token flow
// (foundry.service.ts:173-191) for environments where the interactive VS Code
// Microsoft provider is unavailable (CI, remote agents). It is an OPTIONAL path:
// `@azure/identity` is an optionalDependency and loaded lazily so the extension
// still works without it. Primary auth is always azureAuth.ts.
//
// Credentials (tenantId/clientId/clientSecret) are read from SecretStorage via
// secretStore.ts — never hard-coded. Prefer short-lived provider tokens; only
// fall back to this when an automation context truly requires it.

import { getCachedToken, setCachedToken } from './tokenCache'

export interface ClientSecretConfig {
  tenantId: string
  clientId: string
  clientSecret: string
}

const FALLBACK_ACCOUNT_KEY = 'client-secret'

/**
 * Acquire a token for `scope` using a confidential-client credential.
 * Lazily imports `@azure/identity`; throws a clear error if it isn't installed.
 */
export async function getTokenViaClientSecret(config: ClientSecretConfig, scope: string): Promise<string> {
  const cached = getCachedToken(FALLBACK_ACCOUNT_KEY, scope)
  if (cached) {
    return cached
  }

  let identity: typeof import('@azure/identity')
  try {
    identity = await import('@azure/identity')
  } catch {
    throw new Error(
      'The ClientSecretCredential fallback requires the optional "@azure/identity" package. ' +
        'Run `npm install @azure/identity` in the extension folder, or use interactive sign-in instead.',
    )
  }

  const credential = new identity.ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret)
  const result = await credential.getToken(scope)
  if (!result?.token) {
    throw new Error('Azure returned no token for the client-secret credential.')
  }

  setCachedToken(
    FALLBACK_ACCOUNT_KEY,
    scope,
    result.token,
    result.expiresOnTimestamp ?? Date.now() + 3_300_000,
  )
  return result.token
}
