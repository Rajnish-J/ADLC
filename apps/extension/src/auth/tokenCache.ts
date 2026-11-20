// In-process token cache with a 60s grace window.
//
// Harvested pattern from the analytics repo's foundry.service.ts:39-57.
// The VS Code Microsoft auth provider already caches sessions, so this is
// primarily used by the ClientSecretCredential fallback (clientSecretFallback.ts)
// where we hold raw tokens ourselves. Keyed by `${account}:${scope}`.

import { TOKEN_GRACE_MS } from '../foundry/constants'

interface CachedToken {
  token: string
  expiresAt: number
}

const cache = new Map<string, CachedToken>()

function keyFor(account: string, scope: string): string {
  return `${account}:${scope}`
}

export function getCachedToken(account: string, scope: string): string | null {
  const hit = cache.get(keyFor(account, scope))
  if (hit && hit.expiresAt - TOKEN_GRACE_MS > Date.now()) {
    return hit.token
  }
  return null
}

export function setCachedToken(account: string, scope: string, token: string, expiresAt: number): void {
  cache.set(keyFor(account, scope), { token, expiresAt })
}

export function invalidateAccountTokens(account: string): void {
  const prefix = `${account}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}

export function clearTokenCache(): void {
  cache.clear()
}
