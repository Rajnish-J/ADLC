// Unit tests for the Azure Boards sync's pure parts: the WIQL, the REST calls (against a fake fetch), HTML → text,
// and the work item → story mapping. Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AdoRequestError,
  buildAssignedToWiql,
  fetchAssignedWorkItems,
  fetchStateCategories,
  guessStateCategory,
  htmlToText,
  patAuthHeader,
  splitCriteria,
  ME,
  workItemDescription,
  type FetchLike,
} from '@sdlc/core'
import {
  boardsDefaultsFromRepo,
  BoardsPruneResultSchema,
  labelsForAdoTags,
  storyPriorityForAdo,
  storyStatusForCategory,
  UpdateBoardsIdentityInputSchema,
} from '@sdlc/contracts'
import { selectOutOfArea, storyDescription, syncAccess } from './boardsSync'

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown }

function fakeFetch(routes: Array<[RegExp, (c: Call) => { status?: number; body: unknown }]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const route = routes.find(([re]) => re.test(url))
    const res = route ? route[1](call) : { status: 404, body: { message: 'no route' } }
    const status = res.status ?? 200
    return { ok: status < 400, status, statusText: String(status), text: async () => JSON.stringify(res.body) }
  }
  return { fetch, calls }
}

describe('buildAssignedToWiql', () => {
  it('filters by project, assignee, types and not-removed, and escapes every value', () => {
    const q = buildAssignedToWiql({ project: "O'Brien Hub", identity: "o'neil@contoso.com", types: ['User Story', 'Bug'] })
    assert.match(q, /\[System\.TeamProject\] = 'O''Brien Hub'/)
    assert.match(q, /\[System\.AssignedTo\] = 'o''neil@contoso\.com'/)
    assert.match(q, /\[System\.WorkItemType\] IN \('User Story', 'Bug'\)/)
    assert.match(q, /\[System\.State\] <> 'Removed'/)
    assert.match(q, /ORDER BY \[System\.ChangedDate\] DESC$/)
  })

  it('falls back to the default types when none are given', () => {
    assert.match(buildAssignedToWiql({ project: 'P', identity: 'a@b.c', types: [] }), /'Product Backlog Item'/)
  })
})

describe('fetchAssignedWorkItems', () => {
  const access = (fetch: FetchLike) => ({ org: 'contoso', project: 'Payments Hub', authorization: patAuthHeader('pat123'), fetch })

  it('runs the WIQL, batches the ids and maps the fields', async () => {
    const { fetch, calls } = fakeFetch([
      [/_apis\/wit\/wiql/, () => ({ body: { workItems: [{ id: 7 }, { id: 9 }] } })],
      [
        /workitemsbatch/,
        () => ({
          body: {
            value: [
              {
                id: 9,
                fields: {
                  'System.Title': 'Fix login',
                  'System.WorkItemType': 'Bug',
                  'System.State': 'Active',
                  'System.ChangedDate': '2026-11-10T10:00:00Z',
                  'Microsoft.VSTS.Common.Priority': 1,
                },
              },
              {
                id: 7,
                fields: {
                  'System.Title': 'Reset password',
                  'System.WorkItemType': 'User Story',
                  'System.State': 'New',
                  'System.Description': '<div>As a user&nbsp;I want <b>reset</b>.</div>',
                  'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>Email sent</li><li>Link expires &amp; is single-use</li></ul>',
                  'System.Tags': 'Security; Login',
                  'System.AssignedTo': { uniqueName: 'dev@contoso.com', displayName: 'Dev' },
                  'System.ChangedDate': '2026-11-11T10:00:00Z',
                },
              },
            ],
          },
        }),
      ],
    ])
    const items = await fetchAssignedWorkItems(access(fetch), { identity: 'dev@contoso.com', types: ['User Story', 'Bug'] })

    assert.equal(calls[0].method, 'POST')
    assert.match(calls[0].url, /^https:\/\/dev\.azure\.com\/contoso\/Payments%20Hub\/_apis\/wit\/wiql\?/)
    assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from(':pat123').toString('base64')}`)
    assert.deepEqual((calls[1].body as { ids: number[] }).ids, [7, 9])

    assert.deepEqual(
      items.map((i) => i.id),
      [7, 9],
      'keeps the WIQL order',
    )
    const story = items[0]
    assert.equal(story.description, 'As a user I want reset.')
    assert.deepEqual(story.acceptanceCriteria, ['Email sent', 'Link expires & is single-use'])
    assert.deepEqual(story.tags, ['Security', 'Login'])
    assert.equal(story.assignedTo?.uniqueName, 'dev@contoso.com')
    assert.equal(story.url, 'https://dev.azure.com/contoso/Payments%20Hub/_workitems/edit/7')
    assert.equal(items[1].priority, 1)
    assert.equal(story.priority, null)
  })

  it('splits more than 200 ids into several batch calls', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }))
    const { fetch, calls } = fakeFetch([
      [/wiql/, () => ({ body: { workItems: ids } })],
      [/workitemsbatch/, (c) => ({ body: { value: (c.body as { ids: number[] }).ids.map((id) => ({ id, fields: { 'System.Title': `#${id}` } })) } })],
    ])
    const items = await fetchAssignedWorkItems(access(fetch), { identity: 'a@b.c', types: ['Task'] })
    assert.equal(items.length, 250)
    assert.equal(calls.filter((c) => /workitemsbatch/.test(c.url)).length, 2)
  })

  it('raises AdoRequestError with the status (and never the token) on failure', async () => {
    const { fetch } = fakeFetch([[/wiql/, () => ({ status: 401, body: { message: 'TF400813: not authorized' } })]])
    await assert.rejects(
      () => fetchAssignedWorkItems(access(fetch), { identity: 'a@b.c', types: [] }),
      (err: unknown) => err instanceof AdoRequestError && err.status === 401 && !err.message.includes('pat123'),
    )
  })

  it('reads a type’s state categories', async () => {
    const { fetch, calls } = fakeFetch([
      [/workitemtypes\/User%20Story\/states/, () => ({ body: { value: [{ name: 'New', category: 'Proposed' }, { name: 'Closed', category: 'Completed' }] } })],
    ])
    assert.deepEqual(await fetchStateCategories(access(fetch), 'User Story'), { New: 'Proposed', Closed: 'Completed' })
    assert.equal(calls[0].method, 'GET')
  })
})

describe('HTML → text', () => {
  it('keeps paragraphs and list items as lines and decodes entities', () => {
    assert.equal(htmlToText('<p>One</p><p>Two&lt;3&gt;</p>'), 'One\nTwo<3>')
    assert.equal(htmlToText(undefined), '')
  })

  it('splits criteria by list item or line, dropping bullets and numbering', () => {
    assert.deepEqual(splitCriteria('<ol><li>First</li><li>Second</li></ol>'), ['First', 'Second'])
    assert.deepEqual(splitCriteria('1. A<br>2) B<br>- C'), ['A', 'B', 'C'])
  })
})

describe('work item → story mapping', () => {
  it('maps state categories onto story statuses', () => {
    assert.equal(storyStatusForCategory('Proposed'), 'ready')
    assert.equal(storyStatusForCategory('InProgress'), 'in_progress')
    assert.equal(storyStatusForCategory('Resolved'), 'in_review')
    assert.equal(storyStatusForCategory('Completed'), 'done')
  })

  it('guesses categories for well-known state names when the type can’t be read', () => {
    assert.equal(guessStateCategory('To Do'), 'Proposed')
    assert.equal(guessStateCategory('Committed'), 'InProgress')
    assert.equal(guessStateCategory('Resolved'), 'Resolved')
    assert.equal(guessStateCategory('Done'), 'Completed')
  })

  it('maps priorities and tags', () => {
    assert.deepEqual([1, 2, 3, 4, null].map(storyPriorityForAdo), ['critical', 'high', 'medium', 'low', 'medium'])
    assert.deepEqual(labelsForAdoTags(['Needs Migration', 'needs migration', 'API v2']), ['needs-migration', 'api-v2'])
  })

  it('derives the Azure Boards link from an Azure Repos repository only', () => {
    assert.deepEqual(boardsDefaultsFromRepo('https://dev.azure.com/contoso/Payments%20Hub/_git/api'), {
      enabled: true,
      organization: 'contoso',
      project: 'Payments Hub',
      workItemTypes: ['User Story', 'Product Backlog Item', 'Requirement', 'Bug', 'Task', 'Issue'],
      areaPath: null,
    })
    assert.equal(boardsDefaultsFromRepo('https://github.com/acme/web'), null)
    assert.equal(boardsDefaultsFromRepo(null), null)
  })

  it('treats an empty identity override as "use my email"', () => {
    assert.equal(UpdateBoardsIdentityInputSchema.parse({ identity: '  ' }).identity, null)
    assert.equal(UpdateBoardsIdentityInputSchema.parse({ identity: 'me@contoso.com' }).identity, 'me@contoso.com')
  })
})

describe('work item context (repro steps, parent)', () => {
  it('uses a Bug’s repro steps when it has no description, and appends them when it has both', () => {
    assert.equal(workItemDescription({ 'Microsoft.VSTS.TCM.ReproSteps': '<div>Open login</div><div>Submit &amp; wait</div>' }), 'Open login\nSubmit & wait')
    assert.equal(
      workItemDescription({ 'System.Description': '<p>Login fails</p>', 'Microsoft.VSTS.TCM.ReproSteps': '<p>Submit twice</p>' }),
      'Login fails\n\nRepro steps:\nSubmit twice',
    )
    assert.equal(workItemDescription({ 'System.Description': '<p>Only this</p>' }), 'Only this')
    assert.equal(workItemDescription({}), '')
  })

  it('requests repro steps and reads parents’ titles in one extra batch (only those not among the items)', async () => {
    const { fetch, calls } = fakeFetch([
      [/_apis\/wit\/wiql/, () => ({ body: { workItems: [{ id: 7 }, { id: 8 }, { id: 9 }] } })],
      [
        /workitemsbatch/,
        (c) =>
          (c.body as { ids: number[] }).ids.includes(7)
            ? {
                body: {
                  value: [
                    { id: 7, fields: { 'System.Title': 'Bug A', 'System.WorkItemType': 'Bug', 'System.Parent': 5, 'Microsoft.VSTS.TCM.ReproSteps': 'Click it' } },
                    { id: 8, fields: { 'System.Title': 'Task B', 'System.Parent': 9 } },
                    { id: 9, fields: { 'System.Title': 'Story C' } },
                  ],
                },
              }
            : { body: { value: [{ id: 5, fields: { 'System.Title': 'Checkout epic' } }] } },
      ],
    ])
    const items = await fetchAssignedWorkItems({ org: 'contoso', project: 'P', authorization: 'x', fetch }, { identity: ME, types: [] })
    assert.ok((calls[1].body as { fields: string[] }).fields.includes('Microsoft.VSTS.TCM.ReproSteps'))
    assert.equal(calls.length, 3)
    assert.deepEqual((calls[2].body as { ids: number[] }).ids, [5])
    assert.equal(calls[2].url, 'https://dev.azure.com/contoso/_apis/wit/workitemsbatch?api-version=7.1')
    assert.equal(items[0].description, 'Click it')
    assert.deepEqual(items[0].parent, { id: 5, title: 'Checkout epic' })
    assert.deepEqual(items[1].parent, { id: 9, title: 'Story C' })
    assert.equal(items[2].parent, null)
  })

  it('makes no extra call when no item has a parent', async () => {
    const { fetch, calls } = fakeFetch([
      [/wiql/, () => ({ body: { workItems: [{ id: 1 }] } })],
      [/workitemsbatch/, () => ({ body: { value: [{ id: 1, fields: { 'System.Title': 'Solo' } }] } })],
    ])
    await fetchAssignedWorkItems({ org: 'contoso', project: 'P', authorization: 'x', fetch }, { identity: 'a@b.c', types: [] })
    assert.equal(calls.length, 2)
  })

  it('adds a parent line to the story description', () => {
    assert.equal(storyDescription({ description: 'Do it', parentId: 5, parent: { id: 5, title: 'Checkout epic' } }), 'Do it\n\nParent: #5 Checkout epic')
    assert.equal(storyDescription({ description: '', parentId: 5, parent: { id: 5, title: 'Checkout epic' } }), 'Parent: #5 Checkout epic')
    assert.equal(storyDescription({ description: 'Do it', parentId: 5, parent: null }), 'Do it\n\nParent: #5')
    assert.equal(storyDescription({ description: 'Do it', parentId: null, parent: null }), 'Do it')
  })
})

describe('project sync access and area', () => {
  it('limits the WIQL to the area and its children, escaping apostrophes', () => {
    const q = buildAssignedToWiql({ project: 'Hub', identity: 'a@b.c', types: ['Bug'], areaPath: "Hub\\Rock 'n' Roll" })
    assert.match(q, /\[System\.AreaPath\] UNDER 'Hub\\Rock ''n'' Roll'/)
    assert.doesNotMatch(buildAssignedToWiql({ project: 'Hub', identity: 'a@b.c', types: [], areaPath: null }), /AreaPath/)
    assert.doesNotMatch(buildAssignedToWiql({ project: 'Hub', identity: 'a@b.c', types: [], areaPath: '' }), /AreaPath/)
  })

  it('matches @Me (unquoted) with the caller’s own token, else their identity with the org connection', () => {
    assert.deepEqual(syncAccess('mine', 'org', 'dev@contoso.com'), { token: 'mine', identity: ME })
    assert.deepEqual(syncAccess(null, 'org', 'dev@contoso.com'), { token: 'org', identity: 'dev@contoso.com' })
    assert.deepEqual(syncAccess(undefined, '', 'dev@contoso.com'), null)
    const own = syncAccess('mine', null, 'x')!
    assert.match(buildAssignedToWiql({ project: 'P', identity: own.identity, types: [] }), /\[System\.AssignedTo\] = @Me AND/)
    assert.match(buildAssignedToWiql({ project: 'P', identity: "o'neil@contoso.com", types: [] }), /\[System\.AssignedTo\] = 'o''neil@contoso\.com'/)
  })

  it('selects stories whose work item is outside the area, skipping unknown items and sorting by number', () => {
    const linked = [
      { number: 4, externalId: '40', storyId: 's4' },
      { number: 2, externalId: '20', storyId: 's2' },
      { number: 3, externalId: '30', storyId: 's3' },
      { number: 1, externalId: '10', storyId: 's1' },
      { number: 5, externalId: '50', storyId: 's5' },
    ]
    const areas = new Map([
      [10, 'Hub\\Synfra'],
      [20, 'Hub\\Intellidoc'],
      [30, 'hub\\synfra\\API'],
      [40, 'Hub\\Synfra2'],
      // 50: Azure DevOps no longer returns it — kept.
    ])
    const out = selectOutOfArea(linked, areas, 'Hub\\Synfra')
    assert.deepEqual(
      out.map((o) => [o.number, o.storyId, o.workItemId, o.areaPath]),
      [
        [2, 's2', 20, 'Hub\\Intellidoc'],
        [4, 's4', 40, 'Hub\\Synfra2'],
      ],
    )
  })

  it('defaults the prune result’s run count to 0', () => {
    assert.equal(BoardsPruneResultSchema.parse({ areaPath: 'Hub', stories: [], removed: false }).runs, 0)
    assert.equal(BoardsPruneResultSchema.parse({ areaPath: 'Hub', stories: [], runs: 3, removed: false }).runs, 3)
  })
})
