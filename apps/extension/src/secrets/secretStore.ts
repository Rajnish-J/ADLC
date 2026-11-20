// SecretStorage wrapper (T3).
//
// Thin typed layer over `context.secrets` (vscode.SecretStorage), which is
// backed by the OS keychain and encrypted at rest per-user. This replaces the
// analytics repo's custom AES-GCM vault (credentials-crypto.ts) — VS Code does
// the encryption and key management for us.
//
// Principle: store as little as possible. We persist non-sensitive connection
// metadata (selected tenant/subscription/resource-group/account) plus, only if
// the user opts into the headless fallback, the client-secret credentials.

import * as vscode from 'vscode'
import type { ClientSecretConfig } from '../auth/clientSecretFallback'
import type { StoredConnection } from '../foundry/types'

const CONNECTION_KEY = 'sdlcGovernance.connection'
const CLIENT_SECRET_KEY = 'sdlcGovernance.clientSecret'
const APP_INSIGHTS_KEY = 'sdlcGovernance.appInsightsConnectionString'

export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Fires when a secret changes (including external changes), so the UI can react. */
  get onDidChange(): vscode.Event<vscode.SecretStorageChangeEvent> {
    return this.secrets.onDidChange
  }

  // ─── Connection metadata (non-sensitive) ────────────────────────────────────

  async getConnection(): Promise<StoredConnection | undefined> {
    const raw = await this.secrets.get(CONNECTION_KEY)
    if (!raw) {
      return undefined
    }
    try {
      return JSON.parse(raw) as StoredConnection
    } catch {
      return undefined
    }
  }

  async setConnection(connection: StoredConnection): Promise<void> {
    await this.secrets.store(CONNECTION_KEY, JSON.stringify(connection))
  }

  // ─── Client-secret fallback credentials (sensitive, opt-in) ──────────────────

  async getClientSecret(): Promise<ClientSecretConfig | undefined> {
    const raw = await this.secrets.get(CLIENT_SECRET_KEY)
    if (!raw) {
      return undefined
    }
    try {
      return JSON.parse(raw) as ClientSecretConfig
    } catch {
      return undefined
    }
  }

  async setClientSecret(config: ClientSecretConfig): Promise<void> {
    await this.secrets.store(CLIENT_SECRET_KEY, JSON.stringify(config))
  }

  // ─── App Insights connection string (sensitive, opt-in) ──────────────────────

  /** Read the App Insights connection string (resolved secret-first by callers). */
  get(key: string): Thenable<string | undefined> {
    return this.secrets.get(key)
  }

  async getAppInsightsConnectionString(): Promise<string | undefined> {
    return this.secrets.get(APP_INSIGHTS_KEY)
  }

  async setAppInsightsConnectionString(value: string): Promise<void> {
    await this.secrets.store(APP_INSIGHTS_KEY, value)
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /** Removes all stored connection state (the `Clear connection` command). */
  async clear(): Promise<void> {
    await this.secrets.delete(CONNECTION_KEY)
    await this.secrets.delete(CLIENT_SECRET_KEY)
    await this.secrets.delete(APP_INSIGHTS_KEY)
  }
}
