// Azure sign-in via the VS Code built-in Microsoft authentication provider (T2).
//
// Portable across macOS/Windows/Linux and requires no app-registration secret —
// the provider negotiates tokens for the developer's work account. We request
// per-scope sessions (ARM scope for management-plane calls, Foundry scope for the
// data plane) since a single session token is audience-bound to one resource.
//
// For headless/CI use, see clientSecretFallback.ts (the harvested orka path).

import * as vscode from 'vscode'

const PROVIDER_ID = 'microsoft'

/** Tenant override (optional). When set, scopes are augmented with `VSCODE_TENANT:<id>`. */
let tenantOverride: string | undefined

export function setTenant(tenantId: string | undefined): void {
  tenantOverride = tenantId
}

/**
 * The Microsoft provider expects resource scopes plus offline_access for refresh.
 * A scope like `https://management.azure.com/.default` is passed as the resource;
 * we expand it to the explicit `.default` form the provider understands.
 */
function buildScopes(resourceScope: string): string[] {
  const scopes = [resourceScope, 'offline_access']
  if (tenantOverride) {
    scopes.push(`VSCODE_TENANT:${tenantOverride}`)
  }
  return scopes
}

/**
 * Acquire (or silently reuse) a session for the given resource scope.
 * @param resourceScope ARM_SCOPE or FOUNDRY_SCOPE
 * @param createIfNone when true, prompts the user to sign in if no session exists
 */
export async function getSession(
  resourceScope: string,
  createIfNone: boolean,
): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession(PROVIDER_ID, buildScopes(resourceScope), {
      createIfNone,
    })
  } catch (err) {
    if (err instanceof Error && /cancel/i.test(err.message)) {
      return undefined
    }
    throw err
  }
}

/** Returns a bearer token for the scope, prompting for sign-in if needed. */
export async function getToken(resourceScope: string): Promise<string> {
  const session = await getSession(resourceScope, true)
  if (!session) {
    throw new Error('Azure sign-in was cancelled or no session is available.')
  }
  return session.accessToken
}

/** True when a silent (no-prompt) session already exists for the scope. */
export async function isSignedIn(resourceScope: string): Promise<boolean> {
  const session = await getSession(resourceScope, false)
  return Boolean(session)
}

/** The signed-in account label, if any (uses the ARM scope as the canonical session). */
export async function getAccountLabel(resourceScope: string): Promise<string | undefined> {
  const session = await getSession(resourceScope, false)
  return session?.account.label
}
