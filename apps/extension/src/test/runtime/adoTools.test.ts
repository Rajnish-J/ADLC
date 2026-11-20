// Azure Boards agent tools — governance gating and the invoke routing.

import * as assert from 'assert'
import { mapAgentToolsToAdoTools } from '../../runtime/dispatch/toolGating'
import { buildAdoTools, type AdoToolConfig } from '../../runtime/dispatch/adoTools'

const adoConfig = (): AdoToolConfig => ({
  org: 'o',
  project: 'p',
  getToken: async () => 'tok',
  workItemId: 42,
})

suite('ADO tool gating', () => {
  test('reads are always granted; writes require declaration + kill-switch on', () => {
    // No declared tools, writes allowed → reads only, no writes.
    let perm = mapAgentToolsToAdoTools(undefined, true)
    assert.strictEqual(perm.read, true)
    assert.strictEqual(perm.write.size, 0)

    // Declares a write tool but kill-switch off → still no writes.
    perm = mapAgentToolsToAdoTools(['update_work_item'], false)
    assert.strictEqual(perm.write.size, 0)

    // Declares a write tool and kill-switch on → that write granted.
    perm = mapAgentToolsToAdoTools(['update_work_item'], true)
    assert.ok(perm.write.has('update_work_item'))
    assert.ok(!perm.write.has('add_work_item_comment'))

    // A board "group" capability grants all writes (when enabled).
    perm = mapAgentToolsToAdoTools(['azure_devops'], true)
    assert.ok(perm.write.has('update_work_item'))
    assert.ok(perm.write.has('add_work_item_comment'))
  })
})

suite('ADO tools — buildAdoTools', () => {
  test('offers no tools when ADO is not configured', () => {
    const { defs } = buildAdoTools({ read: true, write: new Set(['update_work_item']) }, undefined)
    assert.strictEqual(defs.length, 0)
  })

  test('offers read tools and only the granted write tools', () => {
    const { defs } = buildAdoTools(
      { read: true, write: new Set(['update_work_item']) },
      adoConfig(),
    )
    const names = defs.map((d) => d.name)
    assert.ok(names.includes('list_work_items'))
    assert.ok(names.includes('get_work_item'))
    assert.ok(names.includes('update_work_item'))
    assert.ok(!names.includes('add_work_item_comment'))
  })

  test('invoke refuses a tool that was not offered', async () => {
    const { invoke } = buildAdoTools({ read: true, write: new Set() }, adoConfig())
    const out = await invoke('update_work_item', { fields: { state: 'Closed' } }, {} as never)
    assert.match(out, /not permitted/)
  })

  test('get_work_item falls back to the run\'s seeded work item id', async () => {
    const original = globalThis.fetch
    let requestedUrl = ''
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 42, fields: { 'System.Title': 'Seeded' } }),
      } as Response
    }) as typeof fetch
    try {
      const { invoke } = buildAdoTools({ read: true, write: new Set() }, adoConfig())
      const out = await invoke('get_work_item', {}, {} as never)
      assert.match(requestedUrl, /workitems\/42\?/)
      assert.match(out, /Seeded/)
    } finally {
      globalThis.fetch = original
    }
  })
})
