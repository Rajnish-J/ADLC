// Unit tests for the chat module's pure parts: the assistant definitions, tool gating and approvals, what a client
// may change in the history, draft checks, and linear workflow drafts. Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { UIMessage } from 'ai'
import { DRAFT_DATA_SCHEMAS, DRAFT_KINDS, EMPTY_DRAFT_DATA, type Actor } from '@sdlc/contracts'
import { specToWorkflowDraft, STORY_DELIVERY_SPEC, validateWorkflowSpec, workflowDraftToSpec } from '@sdlc/core'
import { loadAgents, parseAgentFile } from './agents/loader'
import { describeModelError, mergeClientUpdate, sanitizeUserMessage } from './engine'
import { resolveAzureBaseUrl } from './llm'
import { buildToolset, KNOWN_TOOL_NAMES, PLATFORM_TOOLS, toolAvailability, toolDefsFor } from './tools'
import { draftProblems } from './tools/drafts'
import type { ChatToolContext } from './tools/kit'

const admin: Actor = { userId: 'a', orgRole: 'org_admin' }
const member: Actor = { userId: 'm', orgRole: 'member' }

describe('assistant definitions', () => {
  const agents = loadAgents()

  it('loads every definition, default first, with unique names', () => {
    assert.equal(agents[0].name, 'default')
    assert.equal(new Set(agents.map((a) => a.name)).size, agents.length)
    assert.deepEqual(
      agents.map((a) => a.name).sort(),
      ['agents', 'default', 'memory', 'portfolio', 'projects', 'repos', 'runs', 'skills', 'stories', 'workflows'],
    )
  })

  it('only names tools that exist, and builders can draft and ask', () => {
    for (const a of agents) {
      for (const t of a.tools) assert.ok(KNOWN_TOOL_NAMES.has(t), `${a.name}: ${t}`)
      assert.ok(a.tools.includes('ask_user'), `${a.name} can ask the user`)
      if (a.draft) assert.ok(a.tools.includes('update_draft'), `${a.name} drafts`)
      assert.ok(a.prompt.length > 200, `${a.name} has instructions`)
    }
  })

  it('keeps Default and Portfolio read-only', () => {
    for (const name of ['default', 'portfolio']) {
      const a = agents.find((x) => x.name === name)!
      const writes = toolDefsFor(a.tools, a.draft).filter((t) => t.access === 'write')
      assert.deepEqual(writes, [], name)
    }
  })

  it('rejects unknown tools and a name that does not match the file', () => {
    const fm = (extra: string) => `---\nname: x\nlabel: X\nicon: Bot\ndescription: d\nscope: org\ntools:\n  - ${extra}\n---\nbody`
    assert.throws(() => parseAgentFile('x.md', fm('drop_database')), /unknown tool/)
    assert.throws(() => parseAgentFile('y.md', fm('ask_user')), /match the file name/)
    assert.throws(() => parseAgentFile('x.md', fm('update_draft')), /needs a `draft` kind/)
  })
})

describe('tool gating', () => {
  const workflows = loadAgents().find((a) => a.name === 'workflows')!
  const defs = toolDefsFor(workflows.tools, workflows.draft)
  const gate = (over: Partial<Parameters<typeof toolAvailability>[1]>) =>
    toolAvailability(defs, { actor: member, projectRole: 'developer', hasProject: true, toolMode: 'auto', disabled: [], ...over })
  const unavailable = (rows: ReturnType<typeof gate>) => rows.filter((r) => !r.available).map((r) => r.name)

  it('hides lead-only writes from a developer but not from a lead or org admin', () => {
    assert.ok(unavailable(gate({})).includes('set_step_agent'))
    assert.deepEqual(unavailable(gate({ projectRole: 'lead' })), [])
    assert.deepEqual(unavailable(gate({ actor: admin, projectRole: undefined })), [])
  })

  it('read-only mode drops every write but keeps drafting and questions', () => {
    const rows = gate({ projectRole: 'lead', toolMode: 'read-only' })
    for (const r of rows) {
      if (r.def.kind === 'draft' || r.def.kind === 'interaction') assert.ok(r.available, r.name)
      else assert.equal(r.available, r.access === 'read', r.name)
    }
  })

  it('honours tools the user switched off', () => {
    assert.ok(unavailable(gate({ projectRole: 'lead', disabled: ['delete_workflow'] })).includes('delete_workflow'))
  })

  it('org-level tools are for org admins only', () => {
    const repos = loadAgents().find((a) => a.name === 'repos')!
    const rows = toolAvailability(toolDefsFor(repos.tools, null), { actor: member, projectRole: 'owner', hasProject: true, toolMode: 'auto', disabled: [] })
    assert.equal(rows.find((r) => r.name === 'list_git_connections')?.available, false)
  })

  it('every write needs approval; in ask mode reads do too; drafts and questions never', () => {
    const ctx = {} as ChatToolContext
    const auto = buildToolset(defs, ctx, 'auto').approval
    const ask = buildToolset(defs, ctx, 'ask').approval
    for (const d of defs) {
      const platform = d.kind === undefined || d.kind === 'platform'
      assert.equal(auto[d.name], platform && d.access === 'write' ? 'user-approval' : 'not-applicable', `auto ${d.name}`)
      assert.equal(ask[d.name], platform ? 'user-approval' : 'not-applicable', `ask ${d.name}`)
    }
  })

  it('every platform write declares the permission it needs', () => {
    for (const t of PLATFORM_TOOLS.filter((t) => t.access === 'write')) assert.ok(t.permission, t.name)
  })
})

describe('client updates to the history', () => {
  const stored: UIMessage = {
    id: 'msg1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'I will assign it.' },
      { type: 'tool-assign_story', toolCallId: 'c1', state: 'approval-requested', input: { number: 3 }, approval: { id: 'ap1', signature: 'sig' } },
      { type: 'tool-ask_user', toolCallId: 'c2', state: 'input-available', input: { questions: [] } },
      { type: 'tool-list_stories', toolCallId: 'c3', state: 'output-available', input: {}, output: { total: 1 } },
    ] as unknown as UIMessage['parts'],
  }
  const part = (m: UIMessage, id: string) => (m.parts as unknown as { toolCallId?: string }[]).find((p) => p.toolCallId === id) as Record<string, unknown>

  it('accepts an approval response for the pending approval, keeping the server-side approval fields', () => {
    const incoming = structuredClone(stored)
    Object.assign(part(incoming, 'c1'), { state: 'approval-responded', approval: { id: 'ap1', approved: true } })
    const merged = part(mergeClientUpdate(stored, incoming), 'c1')
    assert.equal(merged.state, 'approval-responded')
    assert.deepEqual(merged.approval, { id: 'ap1', signature: 'sig', approved: true })
  })

  it('ignores an approval for another approval id', () => {
    const incoming = structuredClone(stored)
    Object.assign(part(incoming, 'c1'), { state: 'approval-responded', approval: { id: 'forged', approved: true } })
    assert.equal(part(mergeClientUpdate(stored, incoming), 'c1').state, 'approval-requested')
  })

  it('accepts a valid ask_user answer but never a faked server tool result or text', () => {
    const incoming = structuredClone(stored)
    Object.assign(part(incoming, 'c2'), { state: 'output-available', output: { answers: [{ id: 'q', question: 'Q?', answer: 'Yes' }], skipped: false } })
    Object.assign(part(incoming, 'c3'), { output: { total: 999 } })
    ;(incoming.parts[0] as { text: string }).text = 'rewritten'
    const merged = mergeClientUpdate(stored, incoming)
    assert.equal(part(merged, 'c2').state, 'output-available')
    assert.deepEqual(part(merged, 'c3').output, { total: 1 })
    assert.equal((merged.parts[0] as { text: string }).text, 'I will assign it.')
  })

  it('rejects a malformed ask_user answer', () => {
    const incoming = structuredClone(stored)
    Object.assign(part(incoming, 'c2'), { state: 'output-available', output: { nope: true } })
    assert.equal(part(mergeClientUpdate(stored, incoming), 'c2').state, 'input-available')
  })

  it('keeps only text in a new user message', () => {
    const m = sanitizeUserMessage({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }, { type: 'tool-x', toolCallId: 'z' }] as unknown as UIMessage['parts'] })
    assert.deepEqual(m.parts, [{ type: 'text', text: 'hi' }])
    assert.throws(() => sanitizeUserMessage({ id: 'u', role: 'user', parts: [{ type: 'text', text: '  ' }] }), /empty/)
  })
})

describe('drafts', () => {
  it('the empty draft of every kind is valid data', () => {
    for (const kind of DRAFT_KINDS) assert.ok(DRAFT_DATA_SCHEMAS[kind].safeParse(EMPTY_DRAFT_DATA[kind]).success, kind)
  })

  it('reports what would block submitting', () => {
    assert.ok(draftProblems('agent', { ...EMPTY_DRAFT_DATA.agent, name: 'X', slug: 'Bad Slug', description: 'd', instructions: 'i' }).errors.some((e) => /Slug/.test(e)))
    assert.deepEqual(draftProblems('project', { ...EMPTY_DRAFT_DATA.project, name: 'P', key: 'pay' }).errors, [])
    assert.ok(draftProblems('project', { ...EMPTY_DRAFT_DATA.project, name: 'P', setup: 'repository' }).errors.length > 0)
    assert.ok(draftProblems('stories', { stories: [{ ...{ title: '', description: '', acceptanceCriteria: [], priority: 'medium', status: 'draft', labels: [], dueDate: null, tasks: [] } }] }).errors.length > 0)
  })
})

describe('linear workflow drafts', () => {
  it('round-trips Story delivery and stays valid', () => {
    const r = specToWorkflowDraft(STORY_DELIVERY_SPEC, true)
    assert.ok(r.ok)
    if (!r.ok) return
    assert.equal(r.draft.steps.length, 8)
    assert.equal(r.draft.steps[0].agentSlug, 'planner')
    const spec = workflowDraftToSpec(r.draft, { planner: 'Planner' })
    assert.deepEqual(validateWorkflowSpec(spec).errors, [])
    assert.deepEqual(
      spec.nodes.slice(1, -1).map((n) => n.id),
      STORY_DELIVERY_SPEC.nodes.slice(1, -1).map((n) => n.id),
    )
  })

  it('refuses branching specs instead of flattening them', () => {
    const branched = structuredClone(STORY_DELIVERY_SPEC)
    branched.edges.push({ source: 'plan', target: 'review' })
    const r = specToWorkflowDraft(branched)
    assert.equal(r.ok, false)
  })

  it('re-derives duplicate and reserved step ids', () => {
    const spec = workflowDraftToSpec({
      name: 'W',
      description: '',
      trigger: 'manual',
      setAsDefault: false,
      steps: [
        { id: 'a', kind: 'agent', label: 'One' },
        { id: 'a', kind: 'agent', label: 'Two' },
        { id: 'done', kind: 'approval', label: 'Sign off' },
      ],
    })
    const ids = spec.nodes.map((n) => n.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.deepEqual(validateWorkflowSpec(spec).errors, [])
  })

  it('catches broken specs', () => {
    const bad = structuredClone(STORY_DELIVERY_SPEC)
    bad.edges = bad.edges.slice(0, 3)
    assert.match(validateWorkflowSpec(bad).errors.join(' '), /Not reachable/)
  })
})

describe('model errors', () => {
  it('turns provider failures into something the admin can act on', () => {
    assert.match(describeModelError(Object.assign(new Error('Unauthorized'), { statusCode: 401 })), /AZURE_OPENAI_API_KEY/)
    assert.match(describeModelError(Object.assign(new Error('nope'), { statusCode: 404 })), /deployment/)
    assert.match(describeModelError(new Error('Cannot connect to API: fetch failed')), /AZURE_OPENAI_BASE_URL/)
    assert.equal(describeModelError(new Error('boom')), 'The assistant hit an error. Try again.')
  })
})

describe('Azure endpoint', () => {
  it('moves a resource root onto the v1 surface and keeps v1 / Foundry URLs', () => {
    assert.equal(resolveAzureBaseUrl('https://r.openai.azure.com/'), 'https://r.openai.azure.com/openai/v1')
    assert.equal(resolveAzureBaseUrl('https://r.openai.azure.com/openai'), 'https://r.openai.azure.com/openai/v1')
    assert.equal(resolveAzureBaseUrl('https://r.services.ai.azure.com/openai/v1'), 'https://r.services.ai.azure.com/openai/v1')
    assert.equal(resolveAzureBaseUrl('https://r.services.ai.azure.com/api/projects/p'), 'https://r.services.ai.azure.com/api/projects/p')
  })
})
