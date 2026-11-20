// Foundry view types — harvested from the analytics repo's
// src/types/orka/foundry.types.ts (pure TypeScript, no framework coupling).
// Zod is intentionally omitted in the extension to keep dependencies minimal;
// these are response-shape interfaces only.

export interface AzureSubscription {
  subscriptionId: string
  displayName: string
  state: string
  tenantId?: string
}

export interface AzureResourceGroup {
  id: string
  name: string
  location: string
}

export interface FoundryAccount {
  id: string
  name: string
  kind: string
  location: string
  resourceGroup: string
  endpoint?: string
}

export interface FoundryProject {
  name: string
  displayName: string
  description?: string
  projectEndpoint: string
  accountName: string
  resourceGroup: string
  subscriptionId: string
}

export interface FoundryAgent {
  id: string
  name: string
  description: string
  model: string
  instructions: string
  tools: unknown[]
  createdAt?: string
}

/** Minimal connection metadata persisted to SecretStorage (T3). */
export interface StoredConnection {
  tenantId?: string
  defaultSubscriptionId?: string
  defaultResourceGroup?: string
  defaultAccountName?: string
}
