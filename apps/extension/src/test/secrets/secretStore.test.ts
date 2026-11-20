// T3 — SecretStore round-trip tests.
//
// Exercised against an in-memory vscode.SecretStorage so no OS keychain or interactive login is needed.
// What this proves: values written through the wrapper read back identically, malformed stored JSON degrades
// to `undefined` instead of throwing, `clear()` removes every key the wrapper owns, and `onDidChange` fires.
// What it cannot prove: survival across an Extension Host reload (that needs the real OS-keychain-backed
// store) — verified by hand per README "Run it interactively" (Clear Stored Connection, then Ctrl+R).

import * as assert from 'assert'
import * as vscode from 'vscode'
import { SecretStore } from '../../secrets/secretStore'
import type { ClientSecretConfig } from '../../auth/clientSecretFallback'
import type { StoredConnection } from '../../foundry/types'

const CONNECTION_KEY = 'sdlcGovernance.connection'
const CLIENT_SECRET_KEY = 'sdlcGovernance.clientSecret'
const APP_INSIGHTS_KEY = 'sdlcGovernance.appInsightsConnectionString'

class InMemorySecretStorage implements vscode.SecretStorage {
  private readonly map = new Map<string, string>()
  private readonly emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>()
  readonly onDidChange = this.emitter.event

  async keys(): Promise<string[]> {
    return [...this.map.keys()]
  }
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key)
  }
  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value)
    this.emitter.fire({ key })
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
    this.emitter.fire({ key })
  }
}

const CONNECTION: StoredConnection = {
  tenantId: 'tenant-1',
  defaultSubscriptionId: 'sub-1',
  defaultResourceGroup: 'rg-1',
  defaultAccountName: 'account-1',
}

const CLIENT_SECRET: ClientSecretConfig = {
  tenantId: 'tenant-1',
  clientId: 'client-1',
  clientSecret: 'shh',
}

suite('T3 — SecretStore round-trip', () => {
  let storage: InMemorySecretStorage
  let store: SecretStore

  setup(() => {
    storage = new InMemorySecretStorage()
    store = new SecretStore(storage)
  })

  test('connection metadata round-trips identically', async () => {
    assert.strictEqual(await store.getConnection(), undefined)
    await store.setConnection(CONNECTION)
    assert.deepStrictEqual(await store.getConnection(), CONNECTION)
  })

  test('client-secret fallback credentials round-trip identically', async () => {
    assert.strictEqual(await store.getClientSecret(), undefined)
    await store.setClientSecret(CLIENT_SECRET)
    assert.deepStrictEqual(await store.getClientSecret(), CLIENT_SECRET)
  })

  test('App Insights connection string round-trips and is readable through get()', async () => {
    const value = 'InstrumentationKey=abc;IngestionEndpoint=https://example.invalid/'
    await store.setAppInsightsConnectionString(value)
    assert.strictEqual(await store.getAppInsightsConnectionString(), value)
    assert.strictEqual(await store.get(APP_INSIGHTS_KEY), value)
  })

  test('malformed stored JSON reads back as undefined instead of throwing', async () => {
    await storage.store(CONNECTION_KEY, '{not json')
    await storage.store(CLIENT_SECRET_KEY, '{not json')
    assert.strictEqual(await store.getConnection(), undefined)
    assert.strictEqual(await store.getClientSecret(), undefined)
  })

  test('clear() removes every key the wrapper owns', async () => {
    await store.setConnection(CONNECTION)
    await store.setClientSecret(CLIENT_SECRET)
    await store.setAppInsightsConnectionString('conn')

    await store.clear()

    assert.strictEqual(await store.getConnection(), undefined)
    assert.strictEqual(await store.getClientSecret(), undefined)
    assert.strictEqual(await store.getAppInsightsConnectionString(), undefined)
    assert.deepStrictEqual(await storage.keys(), [])
  })

  test('onDidChange fires for writes and for clear()', async () => {
    const changed: string[] = []
    const sub = store.onDidChange((e) => changed.push(e.key))

    await store.setConnection(CONNECTION)
    await store.clear()
    sub.dispose()

    assert.ok(changed.includes(CONNECTION_KEY), 'a write should fire onDidChange for its key')
    for (const key of [CONNECTION_KEY, CLIENT_SECRET_KEY, APP_INSIGHTS_KEY]) {
      assert.ok(changed.includes(key), `clear() should fire onDidChange for ${key}`)
    }
  })
})
