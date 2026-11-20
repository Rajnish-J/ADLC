// SDLC platform connection: story formatting, SSE parsing and the API client (with a fake fetch).
//
// Pure (no `vscode`): runs under the VS Code test host AND under plain mocha.

import * as assert from 'assert'
import type { Story } from '@sdlc/contracts'
import { PlatformClient, PlatformError } from '../../platform/platformClient'
import { parseSseFrames } from '../../platform/platformEvents'
import { compareStories, isOverdue, quickBranchName, sameRepository, storyBranchName, storyContextValue, storyTagLine, storyTaskPrompt } from '../../platform/storyFormat'

const USER_IDS: Record<string, string> = {
  dev1: '00000000-0000-4000-8000-0000000000d1',
  dev2: '00000000-0000-4000-8000-0000000000d2',
  lead: '00000000-0000-4000-8000-00000000001e',
}
const user = (handle: string, name: string) => ({
  id: USER_IDS[handle],
  email: `${handle}@sdlc.local`,
  displayName: name,
  orgRole: 'member' as const,
})

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    projectKey: 'PAY',
    number: 2,
    key: 'PAY-2',
    title: 'Refund API endpoint',
    description: 'As a support agent, I want to refund a payment.',
    acceptanceCriteria: [
      { id: 'a', text: 'Partial refunds are supported', met: true },
      { id: 'b', text: 'Every refund is audit-logged', met: false },
    ],
    status: 'in_progress',
    priority: 'high',
    isBlocked: false,
    blockedReason: null,
    labels: [],
    dueDate: null,
    rank: 0,
    external: null,
    assignee: user('dev1', 'Devi Developer'),
    createdBy: user('lead', 'Leela Lead'),
    latestRun: null,
    version: 3,
    createdAt: '2026-11-04T10:00:00.000Z',
    updatedAt: '2026-11-04T10:00:00.000Z',
    actions: { canEdit: true, canPickUp: false, canAssign: false, canAddMemory: true, canReportWork: true, transitions: [{ to: 'in_review', label: 'Send for review' }] },
    ...overrides,
  }
}

suite('SDLC platform — story formatting', () => {
  test('branch names are story-keyed slugs', () => {
    assert.strictEqual(storyBranchName(story()), 'story/PAY-2-refund-api-endpoint')
    assert.strictEqual(storyBranchName(story({ title: '  Café & “quotes” — done!!  ' })), 'story/PAY-2-caf-quotes-done')
    assert.ok(storyBranchName(story({ title: 'x'.repeat(200) })).length <= 'story/PAY-2-'.length + 48)
  })

  test('a quick fix gets its own branch named after the prompt and the run', () => {
    assert.strictEqual(quickBranchName('Fix the typo on the Checkout button!', '1a2b3c4d-0000-4000-8000-000000000000'), 'quick/fix-the-typo-on-the-checkout-button-1a2b3c')
    assert.strictEqual(quickBranchName('  ', 'ABCDEF12-0000'), 'quick/abcdef')
    assert.ok(quickBranchName('y'.repeat(200), 'abcdef12').length <= 'quick/'.length + 40 + 1 + 6)
  })

  test('the run prompt carries the story, its description and acceptance criteria', () => {
    const prompt = storyTaskPrompt(story())
    assert.ok(prompt.startsWith('PAY-2: Refund API endpoint'))
    assert.ok(prompt.includes('As a support agent'))
    assert.ok(prompt.includes('- [x] Partial refunds are supported'))
    assert.ok(prompt.includes('- [ ] Every refund is audit-logged'))
  })

  test('context values expose exactly the actions the API allows', () => {
    assert.strictEqual(storyContextValue(story(), USER_IDS.dev1), 'platformStory:move:mine:edit:memory')
    assert.strictEqual(storyContextValue(story(), USER_IDS.dev2), 'platformStory:move:edit:memory')
    const ready = story({ status: 'ready', assignee: null, actions: { canEdit: false, canPickUp: true, canAssign: false, canAddMemory: false, canReportWork: false, transitions: [] } })
    assert.strictEqual(storyContextValue(ready, USER_IDS.dev2), 'platformStory:pickup')
    const lead = story({ actions: { ...story().actions, canAssign: true } })
    assert.strictEqual(storyContextValue(lead, USER_IDS.lead), 'platformStory:move:edit:assign:memory')
  })

  test('repository URLs compare across HTTPS, SSH and .git spellings', () => {
    assert.strictEqual(sameRepository('https://github.com/Acme/Pay.git', 'git@github.com:acme/pay.git'), true)
    assert.strictEqual(sameRepository('https://github.com/acme/pay', 'https://github.com/acme/other'), false)
    assert.strictEqual(
      sameRepository('https://dev.azure.com/org/Proj/_git/pay', 'git@ssh.dev.azure.com:v3/org/Proj/pay'),
      true,
    )
    assert.strictEqual(sameRepository('https://example.com/x.git', 'https://example.com/x.git'), false)
    assert.strictEqual(sameRepository(undefined, 'https://github.com/acme/pay'), false)
    // A clone's remote may carry a token; it still names the same repo.
    assert.strictEqual(sameRepository('https://x-access-token:abc123@github.com/acme/pay.git', 'https://github.com/acme/pay'), true)
    assert.strictEqual(sameRepository('https://org@dev.azure.com/org/Proj/_git/pay', 'https://dev.azure.com/org/Proj/_git/pay'), true)
  })

  test('labels and due date show as one tag line; overdue only before done', () => {
    assert.strictEqual(storyTagLine(story()), '')
    assert.strictEqual(storyTagLine(story({ labels: ['api', 'infra'], dueDate: '2026-11-30' })), '#api #infra · due 2026-11-30')
    assert.strictEqual(storyTagLine(story({ dueDate: '2026-11-30' })), 'due 2026-11-30')
    assert.strictEqual(isOverdue(story({ dueDate: '2026-11-01' }), '2026-11-17'), true)
    assert.strictEqual(isOverdue(story({ dueDate: '2026-11-01', status: 'done' }), '2026-11-17'), false)
    assert.strictEqual(isOverdue(story({ dueDate: '2026-11-30' }), '2026-11-17'), false)
  })

  test('stories sort in board order: column, then rank, then number', () => {
    const sorted = [
      story({ number: 5, status: 'done', rank: 0 }),
      story({ number: 1, status: 'ready', rank: 2048 }),
      story({ number: 3, status: 'ready', rank: 1024 }),
      story({ number: 2, status: 'ready', rank: 1024 }),
    ].sort(compareStories)
    assert.deepStrictEqual(sorted.map((s) => s.number), [2, 3, 1, 5])
  })
})

suite('SDLC platform — SSE parsing', () => {
  test('parses platform events, skips keep-alives and other event names, keeps partial frames', () => {
    const input =
      ': keep-alive\n\n' +
      'event: platform\ndata: {"type":"ready"}\n\n' +
      'event: other\ndata: {"type":"ready"}\n\n' +
      'event: platform\r\ndata: {"type":"story.changed","projectKey":"PAY","storyNumber":2,"action":"picked up","actorId":null}\r\n\r\n' +
      'event: platform\ndata: {"type":"project.chan'
    const { events, rest } = parseSseFrames(input)
    assert.deepStrictEqual(
      events.map((e) => e.type),
      ['ready', 'story.changed'],
    )
    assert.ok(rest.startsWith('event: platform'), 'the incomplete frame is kept for the next chunk')
    const next = parseSseFrames(rest + 'ged","projectKey":"PAY","action":"x","actorId":"u"}\n\n')
    assert.strictEqual(next.events[0]?.type, 'project.changed')
  })

  test('malformed frames are ignored', () => {
    assert.deepStrictEqual(parseSseFrames('event: platform\ndata: not json\n\n').events, [])
    assert.deepStrictEqual(parseSseFrames('event: platform\ndata: {"type":"nope"}\n\n').events, [])
  })
})

suite('SDLC platform — API client', () => {
  function fakeFetch(status: number, body: object | string, seen: Array<{ url: string; init?: RequestInit }>) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, init })
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    }
  }

  test('identifies the caller and the client on every request', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const client = new PlatformClient({ apiUrl: 'http://api.test/', devUser: 'dev1@sdlc.local' }, fakeFetch(200, story(), seen))
    const picked = await client.pickUp('PAY', 2)
    assert.strictEqual(picked.key, 'PAY-2')
    assert.strictEqual(seen[0].url, 'http://api.test/api/v1/projects/PAY/stories/2/pickup')
    assert.strictEqual(seen[0].init?.method, 'POST')
    const headers = seen[0].init?.headers as Record<string, string>
    assert.strictEqual(headers['x-dev-user'], 'dev1@sdlc.local')
    assert.strictEqual(headers['x-sdlc-client'], 'extension')
  })

  test('an access token is sent as a bearer token instead of the dev user', () => {
    const headers = new PlatformClient({ apiUrl: 'http://api.test', token: 'sdlc_pat_abc', devUser: 'dev1@sdlc.local' }).headers()
    assert.strictEqual(headers.Authorization, 'Bearer sdlc_pat_abc')
    assert.strictEqual(headers['x-dev-user'], undefined)
    assert.strictEqual(headers['x-sdlc-client'], 'extension')
    assert.strictEqual(new PlatformClient({ apiUrl: 'http://api.test' }).headers().Authorization, undefined)
  })

  test('API errors become PlatformError with the server message and status', async () => {
    const client = new PlatformClient(
      { apiUrl: 'http://api.test' },
      fakeFetch(409, { error: 'conflict', message: 'This story is no longer ready to pick up.' }, []),
    )
    await assert.rejects(client.pickUp('PAY', 1), (e: unknown) => e instanceof PlatformError && e.status === 409 && /no longer ready/.test(e.message))
  })

  test('responses that break the contract are rejected', async () => {
    const client = new PlatformClient({ apiUrl: 'http://api.test' }, fakeFetch(200, [{ key: 'PAY' }], []))
    await assert.rejects(client.projects(), (e: unknown) => e instanceof PlatformError && /Unexpected response/.test(e.message))
  })

  test('story edits, assignment and activity use the web app’s endpoints', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const client = new PlatformClient({ apiUrl: 'http://api.test' }, fakeFetch(200, story(), seen))
    await client.createStory('PAY', { title: 'Refund API endpoint', status: 'ready' })
    await client.updateStory('PAY', 2, { version: 3, labels: ['api'] })
    await client.assignStory('PAY', 2, null)
    assert.deepStrictEqual(
      seen.map((s) => `${s.init?.method} ${s.url.replace('http://api.test/api/v1', '')} ${s.init?.body ?? ''}`),
      [
        'POST /projects/PAY/stories {"title":"Refund API endpoint","status":"ready"}',
        'PATCH /projects/PAY/stories/2 {"version":3,"labels":["api"]}',
        'POST /projects/PAY/stories/2/assign {"userId":null}',
      ],
    )
    const activity: Array<{ url: string; init?: RequestInit }> = []
    await new PlatformClient({ apiUrl: 'http://api.test' }, fakeFetch(200, [], activity)).storyActivity('PAY', 2, 41)
    assert.strictEqual(activity[0].url, 'http://api.test/api/v1/projects/PAY/stories/2/activity?before=41')
  })

  test('an unreachable API is reported as such', async () => {
    const client = new PlatformClient({ apiUrl: 'http://api.test' }, async () => {
      throw new TypeError('fetch failed')
    })
    await assert.rejects(client.me(), (e: unknown) => e instanceof PlatformError && e.status === undefined && /Cannot reach/.test(e.message))
  })
})
