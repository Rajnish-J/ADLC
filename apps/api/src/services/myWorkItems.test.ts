// Unit tests for "My work items": the org-wide @Me WIQL, the org-level REST calls (against a fake fetch), the
// board column mapping and the token input's organization parsing. Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SetAdoTokenInputSchema, suggestAreaPath } from '@sdlc/contracts'
import { AdoRequestError, buildAssignedToWiql, buildMyWorkItemsWiql, fetchAreaPaths, fetchMyWorkItems, isUnderArea, ME, patAuthHeader, type FetchLike } from '@sdlc/core'
import { boardCategory, connectionUsable } from './myWorkItems'

type Call = { url: string; method: string; body?: unknown }

function fakeFetch(routes: Array<[RegExp, (c: Call) => { status?: number; body: unknown; raw?: string }]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const route = routes.find(([re]) => re.test(url))
    const res = route ? route[1](call) : { status: 404, body: { message: 'no route' } }
    const status = res.status ?? 200
    return { ok: status < 400, status, statusText: String(status), text: async () => res.raw ?? JSON.stringify(res.body) }
  }
  return { fetch, calls }
}

const access = (fetch: FetchLike) => ({ org: 'contoso', authorization: patAuthHeader('pat123'), fetch })

describe('buildMyWorkItemsWiql', () => {
  it('asks for everything assigned to @Me except removed items, in any project, newest change first', () => {
    const q = buildMyWorkItemsWiql()
    assert.match(q, /\[System\.AssignedTo\] = @Me/)
    assert.match(q, /\[System\.State\] <> 'Removed'/)
    assert.doesNotMatch(q, /TeamProject|WorkItemType/)
    assert.match(q, /ORDER BY \[System\.ChangedDate\] DESC$/)
  })
})

describe('fetchMyWorkItems', () => {
  it('uses the organization-level endpoints and builds each URL from the item’s own project', async () => {
    const { fetch, calls } = fakeFetch([
      [/_apis\/wit\/wiql/, () => ({ body: { workItems: [{ id: 7 }, { id: 9 }] } })],
      [
        /_apis\/wit\/workitemsbatch/,
        () => ({
          body: {
            value: [
              { id: 9, fields: { 'System.Title': 'Fix login', 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.TeamProject': 'Web App' } },
              { id: 7, fields: { 'System.Title': 'Export CSV', 'System.WorkItemType': 'User Story', 'System.State': 'New', 'System.TeamProject': 'Payments' } },
            ],
          },
        }),
      ],
    ])
    const items = await fetchMyWorkItems(access(fetch))
    assert.equal(calls[0].url, 'https://dev.azure.com/contoso/_apis/wit/wiql?$top=500&api-version=7.1')
    assert.equal(calls[1].url, 'https://dev.azure.com/contoso/_apis/wit/workitemsbatch?api-version=7.1')
    assert.ok((calls[1].body as { fields: string[] }).fields.includes('System.TeamProject'))
    assert.deepEqual(
      items.map((i) => [i.id, i.project, i.url]),
      [
        [7, 'Payments', 'https://dev.azure.com/contoso/Payments/_workitems/edit/7'],
        [9, 'Web App', 'https://dev.azure.com/contoso/Web%20App/_workitems/edit/9'],
      ],
    )
  })

  it('treats the sign-in page (203 / HTML) as a rejected token', async () => {
    const { fetch } = fakeFetch([[/wiql/, () => ({ status: 203, body: null, raw: '<html>sign in</html>' })]])
    await assert.rejects(fetchMyWorkItems(access(fetch)), (e: unknown) => e instanceof AdoRequestError && e.status === 203)
    const html = fakeFetch([[/wiql/, () => ({ body: null, raw: '<html>sign in</html>' })]])
    await assert.rejects(fetchMyWorkItems(access(html.fetch)), (e: unknown) => e instanceof AdoRequestError && e.status === 203)
  })
})

describe('boardCategory', () => {
  it('keeps the four columns and puts anything else in Active', () => {
    assert.equal(boardCategory('Proposed'), 'Proposed')
    assert.equal(boardCategory('Resolved'), 'Resolved')
    assert.equal(boardCategory('Completed'), 'Completed')
    assert.equal(boardCategory('InProgress'), 'InProgress')
    assert.equal(boardCategory('Removed'), 'InProgress')
  })
})

describe('SetAdoTokenInputSchema', () => {
  it('reduces a pasted URL to the organization', () => {
    for (const org of ['contoso', 'https://dev.azure.com/contoso', 'dev.azure.com/contoso/Payments', 'https://contoso.visualstudio.com/Payments']) {
      assert.equal(SetAdoTokenInputSchema.parse({ organization: org, token: 'x' }).organization, 'contoso', org)
    }
  })

  it('needs both fields', () => {
    assert.equal(SetAdoTokenInputSchema.safeParse({ organization: ' ', token: 'x' }).success, false)
    assert.equal(SetAdoTokenInputSchema.safeParse({ organization: 'contoso', token: '' }).success, false)
  })
})

describe('connectionUsable', () => {
  const user = { id: 'u1', email: 'Rajnish.J@synergech.com' }
  it('accepts a connection the user added, or whose token account is their email / identity', () => {
    assert.equal(connectionUsable({ createdBy: 'u1', account: 'someone@else.com' }, user, user.email).usable, true)
    assert.equal(connectionUsable({ createdBy: 'u2', account: 'rajnish.j@synergech.com' }, user, user.email).usable, true)
    assert.equal(connectionUsable({ createdBy: null, account: 'rj@contoso.com' }, user, 'RJ@contoso.com').usable, true)
  })

  it('refuses someone else’s token, saying whose it is', () => {
    const r = connectionUsable({ createdBy: 'u2', account: 'boss@synergech.com' }, user, user.email)
    assert.equal(r.usable, false)
    assert.match(r.reason ?? '', /boss@synergech\.com/)
    assert.equal(connectionUsable({ createdBy: 'u2', account: null }, user, user.email).usable, false)
  })
})

describe('area paths', () => {
  it('limits the project sync query to an area (and its children), and uses @Me unquoted', () => {
    const q = buildAssignedToWiql({ project: 'Product Hub', identity: ME, types: ['Task'], areaPath: "Product Hub\\O'Neil" })
    assert.match(q, /\[System\.AssignedTo\] = @Me /)
    assert.match(q, /\[System\.AreaPath\] UNDER 'Product Hub\\O''Neil'/)
    assert.doesNotMatch(buildAssignedToWiql({ project: 'P', identity: 'a@b.c', types: [] }), /AreaPath/)
  })

  it('flattens the area tree, root first', async () => {
    const { fetch, calls } = fakeFetch([
      [/classificationnodes\/Areas/, () => ({ body: { name: 'Product Hub', children: [{ name: 'Synfra' }, { name: 'Intellidoc', children: [{ name: 'API' }] }] } })],
    ])
    const areas = await fetchAreaPaths({ org: 'contoso', project: 'Product Hub', authorization: 'x', fetch })
    assert.deepEqual(areas, ['Product Hub', 'Product Hub\\Synfra', 'Product Hub\\Intellidoc', 'Product Hub\\Intellidoc\\API'])
    assert.match(calls[0].url, /\/contoso\/Product%20Hub\/_apis\/wit\/classificationnodes\/Areas\?\$depth=10/)
  })

  it('suggests the area named like the project, never the root', () => {
    const areas = ['Product Hub', 'Product Hub\\Synfra', 'Product Hub\\Claude Code Analytics']
    assert.equal(suggestAreaPath(areas, ['synfra', 'SYN']), 'Product Hub\\Synfra')
    assert.equal(suggestAreaPath(areas, ['claude-code-analytics']), 'Product Hub\\Claude Code Analytics')
    assert.equal(suggestAreaPath(areas, ['product hub']), null)
    assert.equal(suggestAreaPath(areas, ['payments']), null)
  })
})

describe('fetchMyWorkItems parents', () => {
  it('reads area, iteration and parent, fetching parent titles that are not among my items', async () => {
    const { fetch, calls } = fakeFetch([
      [/_apis\/wit\/wiql/, () => ({ body: { workItems: [{ id: 7 }] } })],
      [
        /_apis\/wit\/workitemsbatch/,
        (c) =>
          (c.body as { ids: number[] }).ids.includes(7)
            ? { body: { value: [{ id: 7, fields: { 'System.Title': 'Task', 'System.TeamProject': 'P', 'System.AreaPath': 'P\\Synfra', 'System.IterationPath': 'P\\Sprint 3', 'System.Parent': 5 } }] } }
            : { body: { value: [{ id: 5, fields: { 'System.Title': 'The story' } }] } },
      ],
    ])
    const [item] = await fetchMyWorkItems(access(fetch))
    assert.equal(item.areaPath, 'P\\Synfra')
    assert.equal(item.iterationPath, 'P\\Sprint 3')
    assert.deepEqual(item.parent, { id: 5, title: 'The story' })
    assert.deepEqual((calls[2].body as { ids: number[] }).ids, [5])
  })
})

describe('isUnderArea', () => {
  it('matches the area and its sub-areas, case-insensitively, but not siblings sharing a prefix', () => {
    assert.equal(isUnderArea('Hub\\Synfra', 'Hub\\Synfra'), true)
    assert.equal(isUnderArea('hub\\synfra\\API', 'Hub\\Synfra'), true)
    assert.equal(isUnderArea('Hub\\Synfra2', 'Hub\\Synfra'), false)
    assert.equal(isUnderArea('Hub\\Intellidoc', 'Hub\\Synfra'), false)
  })
})
