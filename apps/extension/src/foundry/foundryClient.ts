// Foundry client (T4) — the ARM -> Cognitive -> Foundry list pipeline.
//
// Pure HTTP + Bearer logic harvested from the analytics repo's
// foundry.service.ts:205-338. Decoupled from Next.js/Drizzle: instead of a
// userId + in-service token cache, callers inject a `getToken(scope)` provider
// (azureAuth.getToken in normal use, the client-secret fallback in CI).
//
// Tokens are redacted from error output (regex on the `eyJ…` JWT prefix).

import {
  ARM_SCOPE,
  ARM_SUBSCRIPTIONS_API,
  ARM_RESOURCES_API,
  COGNITIVE_API,
} from './constants'
import type {
  AzureSubscription,
  AzureResourceGroup,
  FoundryAccount,
  FoundryProject,
} from './types'

/** Injected token source — resolves a bearer token for the requested scope. */
export type TokenProvider = (scope: string) => Promise<string>

async function azureFetch<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const sanitised = text.replace(/(eyJ[\w-]{20,})/g, '<token-redacted>')
    throw new Error(`Azure request failed (${res.status}): ${sanitised.slice(0, 500) || res.statusText}`)
  }
  const raw = await res.text()
  return (raw ? JSON.parse(raw) : {}) as T
}

// ─── ARM hierarchy ──────────────────────────────────────────────────────────

export async function listSubscriptions(getToken: TokenProvider): Promise<AzureSubscription[]> {
  const token = await getToken(ARM_SCOPE)
  type Resp = {
    value: Array<{ subscriptionId: string; displayName: string; state: string; tenantId?: string }>
  }
  const data = await azureFetch<Resp>(
    `https://management.azure.com/subscriptions?api-version=${ARM_SUBSCRIPTIONS_API}`,
    token,
  )
  return data.value.map((s) => ({
    subscriptionId: s.subscriptionId,
    displayName: s.displayName,
    state: s.state,
    tenantId: s.tenantId,
  }))
}

export async function listResourceGroups(
  getToken: TokenProvider,
  subscriptionId: string,
): Promise<AzureResourceGroup[]> {
  const token = await getToken(ARM_SCOPE)
  type Resp = { value: Array<{ id: string; name: string; location: string }> }
  const data = await azureFetch<Resp>(
    `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}` +
      `/resourcegroups?api-version=${ARM_RESOURCES_API}`,
    token,
  )
  return data.value.map((g) => ({ id: g.id, name: g.name, location: g.location }))
}

export async function listFoundryAccounts(
  getToken: TokenProvider,
  subscriptionId: string,
  resourceGroup: string,
): Promise<FoundryAccount[]> {
  const token = await getToken(ARM_SCOPE)
  type Resp = {
    value: Array<{
      id: string
      name: string
      kind: string
      location: string
      properties?: { endpoint?: string; endpoints?: Record<string, string> }
    }>
  }
  const url =
    `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/Microsoft.CognitiveServices/accounts?api-version=${COGNITIVE_API}`
  const data = await azureFetch<Resp>(url, token)

  return data.value
    .filter((a) => a.kind === 'AIServices')
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      location: a.location,
      resourceGroup,
      endpoint: a.properties?.endpoint ?? a.properties?.endpoints?.['AI Services'],
    }))
}

export async function listFoundryProjects(
  getToken: TokenProvider,
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
): Promise<FoundryProject[]> {
  const token = await getToken(ARM_SCOPE)
  type Resp = {
    value: Array<{
      name: string
      properties?: { displayName?: string; description?: string; endpoints?: Record<string, string> }
    }>
  }
  const url =
    `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(accountName)}` +
    `/projects?api-version=${COGNITIVE_API}`
  const data = await azureFetch<Resp>(url, token)

  return data.value.map((p) => {
    const endpoints = p.properties?.endpoints ?? {}
    const aiFoundryApi =
      endpoints['AI Foundry API'] ??
      endpoints['AIProjectEndpoint'] ??
      `https://${accountName}.services.ai.azure.com/api/projects/${p.name}`
    return {
      name: p.name,
      displayName: p.properties?.displayName ?? p.name,
      description: p.properties?.description,
      projectEndpoint: aiFoundryApi.replace(/\/+$/, ''),
      accountName,
      resourceGroup,
      subscriptionId,
    }
  })
}

/**
 * Diagnostic counters from a `listAllAccessibleProjectsDetailed` walk — lets a caller distinguish "signed in
 * but zero subscriptions" from "resource groups unreadable (RBAC)" from "no AIServices accounts" from
 * "accounts found but no projects", instead of a single flat empty result. Every level below
 * `listSubscriptions` silently skips failures (expected — a real identity often can't read every
 * subscription/resource-group it's merely listed against), so these counts are the only way to tell which
 * stage actually came up empty.
 */
export interface FoundryDiscoveryDiagnostics {
  subscriptionCount: number
  /** Subscriptions whose resource groups were successfully listed (not necessarily non-empty). */
  readableSubscriptionCount: number
  resourceGroupCount: number
  aiServicesAccountCount: number
  projectCount: number
  /** First few sanitized error messages caught while walking, for troubleshooting. */
  sampleErrors: string[]
}

const MAX_SAMPLE_ERRORS = 3

/**
 * Walk the full hierarchy and return every Foundry project the signed-in identity can see, plus diagnostic
 * counters (see `FoundryDiscoveryDiagnostics`). This is the Phase 1 spike — proving the harvested connection
 * logic works outside Next.js/Drizzle.
 */
export async function listAllAccessibleProjectsDetailed(
  getToken: TokenProvider,
): Promise<{ projects: FoundryProject[]; diagnostics: FoundryDiscoveryDiagnostics }> {
  const projects: FoundryProject[] = []
  const diagnostics: FoundryDiscoveryDiagnostics = {
    subscriptionCount: 0,
    readableSubscriptionCount: 0,
    resourceGroupCount: 0,
    aiServicesAccountCount: 0,
    projectCount: 0,
    sampleErrors: [],
  }
  const recordError = (e: unknown) => {
    if (diagnostics.sampleErrors.length < MAX_SAMPLE_ERRORS) {
      diagnostics.sampleErrors.push(e instanceof Error ? e.message : String(e))
    }
  }

  const subscriptions = await listSubscriptions(getToken)
  diagnostics.subscriptionCount = subscriptions.length

  for (const sub of subscriptions) {
    if (sub.state && sub.state !== 'Enabled') {
      continue
    }
    let groups: AzureResourceGroup[]
    try {
      groups = await listResourceGroups(getToken, sub.subscriptionId)
      diagnostics.readableSubscriptionCount += 1
    } catch (e) {
      recordError(e)
      continue // skip subscriptions we can't read (RBAC)
    }
    diagnostics.resourceGroupCount += groups.length
    for (const group of groups) {
      let accounts: FoundryAccount[]
      try {
        accounts = await listFoundryAccounts(getToken, sub.subscriptionId, group.name)
      } catch (e) {
        recordError(e)
        continue
      }
      diagnostics.aiServicesAccountCount += accounts.length
      for (const account of accounts) {
        try {
          const projs = await listFoundryProjects(getToken, sub.subscriptionId, group.name, account.name)
          projects.push(...projs)
          diagnostics.projectCount += projs.length
        } catch (e) {
          recordError(e)
          // skip accounts we can't enumerate projects for
        }
      }
    }
  }
  return { projects, diagnostics }
}

/**
 * Convenience: walk the full hierarchy and return every Foundry project the signed-in identity can see.
 * Thin wrapper over `listAllAccessibleProjectsDetailed` for callers that only need the project list.
 */
export async function listAllAccessibleProjects(getToken: TokenProvider): Promise<FoundryProject[]> {
  return (await listAllAccessibleProjectsDetailed(getToken)).projects
}
