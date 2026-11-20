// Issue-trigger ADO client — request shaping (WIQL → batch), HTML→text, and the seed-prompt builder.

import * as assert from 'assert'
import {
  fetchAssignedWorkItems,
  workItemToTaskPrompt,
  buildAssignedWiql,
  getWorkItem,
  queryWorkItems,
  updateWorkItem,
  addWorkItemComment,
  DEFAULT_WORK_ITEM_TYPE,
} from '../../integrations/azureDevOps/adoClient'

interface Captured {
  url: string
  method?: string
  body?: unknown
  auth?: string
}

/** Replace global.fetch with a scripted stub; returns captured requests + a restore fn. */
function stubFetch(responder: (url: string, init?: RequestInit) => unknown): {
  calls: Captured[]
  restore: () => void
} {
  const calls: Captured[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    })
    const payload = responder(url, init)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(payload),
    } as Response
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

suite('Issue trigger — ADO client', () => {
  test('buildAssignedWiql filters by @Me and work-item type, escaping quotes', () => {
    const wiql = buildAssignedWiql("Bug's")
    assert.match(wiql, /\[System\.AssignedTo\] = @Me/)
    assert.match(wiql, /\[System\.WorkItemType\] = 'Bug''s'/)
  })

  test('fetchAssignedWorkItems posts WIQL then batch-fetches fields, preserving order', async () => {
    const { calls, restore } = stubFetch((url) => {
      if (url.includes('/wiql')) return { workItems: [{ id: 7 }, { id: 3 }] }
      return {
        value: [
          {
            id: 3,
            fields: {
              'System.Title': 'Second',
              'System.State': 'Active',
              'System.WorkItemType': 'User Story',
              'System.Description': '<p>Hello&nbsp;<b>world</b></p>',
              'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>AC1</li></ul>',
            },
          },
          { id: 7, fields: { 'System.Title': 'First', 'System.State': 'New' } },
        ],
      }
    })
    try {
      const items = await fetchAssignedWorkItems({ org: 'myorg', project: 'proj', token: 'tok' })
      assert.strictEqual(calls.length, 2)
      // First call is the WIQL POST with the default work-item type.
      assert.strictEqual(calls[0].method, 'POST')
      assert.match(calls[0].url, /dev\.azure\.com\/myorg\/proj\/_apis\/wit\/wiql/)
      assert.match(String((calls[0].body as { query: string }).query), new RegExp(DEFAULT_WORK_ITEM_TYPE))
      assert.strictEqual(calls[0].auth, 'Bearer tok')
      // Second call batches the ids returned by the WIQL.
      assert.deepStrictEqual((calls[1].body as { ids: number[] }).ids, [7, 3])
      // Result order follows the WIQL order (7 then 3), not the batch response order.
      assert.deepStrictEqual(items.map((i) => i.id), [7, 3])
      // HTML is stripped to readable text.
      const second = items.find((i) => i.id === 3)!
      assert.strictEqual(second.description, 'Hello world')
      assert.strictEqual(second.acceptanceCriteria, 'AC1')
      assert.match(second.url, /_workitems\/edit\/3$/)
    } finally {
      restore()
    }
  })

  test('fetchAssignedWorkItems short-circuits when no ids are returned', async () => {
    const { calls, restore } = stubFetch(() => ({ workItems: [] }))
    try {
      const items = await fetchAssignedWorkItems({ org: 'o', project: 'p', token: 't' })
      assert.deepStrictEqual(items, [])
      assert.strictEqual(calls.length, 1, 'should not batch-fetch when WIQL is empty')
    } finally {
      restore()
    }
  })

  test('workItemToTaskPrompt includes title, description, AC and source link', () => {
    const prompt = workItemToTaskPrompt({
      id: 42,
      title: 'Add login',
      description: 'Users can log in.',
      acceptanceCriteria: 'Given valid creds…',
      state: 'Active',
      type: 'User Story',
      url: 'https://dev.azure.com/o/p/_workitems/edit/42',
    })
    assert.match(prompt, /User Story #42: Add login/)
    assert.match(prompt, /## Description\nUsers can log in\./)
    assert.match(prompt, /## Acceptance Criteria\nGiven valid creds/)
    assert.match(prompt, /_workitems\/edit\/42/)
  })

  test('getWorkItem requests one item by id with the trimmed field set', async () => {
    const { calls, restore } = stubFetch(() => ({
      id: 42,
      fields: { 'System.Title': 'Login', 'System.State': 'Active', 'System.WorkItemType': 'Bug' },
    }))
    try {
      const wi = await getWorkItem({ org: 'o', project: 'p', token: 't', id: 42 })
      assert.strictEqual(calls.length, 1)
      assert.match(calls[0].url, /_apis\/wit\/workitems\/42\?fields=/)
      assert.strictEqual(wi.id, 42)
      assert.strictEqual(wi.title, 'Login')
      assert.strictEqual(wi.type, 'Bug')
    } finally {
      restore()
    }
  })

  test('queryWorkItems builds a filtered WIQL then batch-fetches', async () => {
    const { calls, restore } = stubFetch((url) => {
      if (url.includes('/wiql')) return { workItems: [{ id: 5 }] }
      return { value: [{ id: 5, fields: { 'System.Title': 'Item' } }] }
    })
    try {
      const items = await queryWorkItems({ org: 'o', project: 'p', token: 't', state: 'Active', workItemType: 'Bug' })
      const query = String((calls[0].body as { query: string }).query)
      assert.match(query, /\[System\.State\] = 'Active'/)
      assert.match(query, /\[System\.WorkItemType\] = 'Bug'/)
      assert.deepStrictEqual(items.map((i) => i.id), [5])
    } finally {
      restore()
    }
  })

  test('updateWorkItem sends a JSON-PATCH for known fields and rejects unknown ones', async () => {
    const { calls, restore } = stubFetch(() => ({ id: 9, fields: { 'System.Title': 'T', 'System.State': 'Closed' } }))
    try {
      await updateWorkItem({ org: 'o', project: 'p', token: 't', id: 9, fields: { state: 'Closed' } })
      assert.strictEqual(calls[0].method, 'PATCH')
      const ops = calls[0].body as Array<{ op: string; path: string; value: unknown }>
      assert.deepStrictEqual(ops, [{ op: 'add', path: '/fields/System.State', value: 'Closed' }])
      await assert.rejects(
        updateWorkItem({ org: 'o', project: 'p', token: 't', id: 9, fields: { bogus: 1 } }),
        /not updatable/,
      )
    } finally {
      restore()
    }
  })

  test('addWorkItemComment posts to the comments preview route', async () => {
    const { calls, restore } = stubFetch(() => ({ id: 101 }))
    try {
      const res = await addWorkItemComment({ org: 'o', project: 'p', token: 't', id: 9, text: 'hi' })
      assert.strictEqual(res.id, 101)
      assert.strictEqual(calls[0].method, 'POST')
      assert.match(calls[0].url, /workItems\/9\/comments\?api-version=7\.1-preview\.4/)
      assert.strictEqual((calls[0].body as { text: string }).text, 'hi')
    } finally {
      restore()
    }
  })
})
