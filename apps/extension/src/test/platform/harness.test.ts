// Harness runs: the step hand-off between the runtime and a harness, hook normalization, the orchestrator prompt,
// and merging the harness's config files without clobbering the user's own settings.

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { StepChannel } from '../../runtime/dispatch/external/stepChannel'
import { normalizeClaudeCode, redact } from '../../platform/bridge/hookNormalizer'
import { launchPrompt, orchestratorMarkdown } from '../../platform/engines/orchestratorPrompt'
import { mergeJson, removeTomlSection, unmergeJson, upsertTomlSection } from '../../platform/session/sessionFiles'
import { DEFAULT_HARNESSES, missingDefaults } from '../../platform/engines/autoInstall'

const dispatch = (phase: 'plan' | 'execute', stepId = 's1', extra: Record<string, unknown> = {}) => ({
  runId: 'r1',
  nodeId: 'n1',
  stepId,
  agentId: 'planner',
  agentName: 'Planner',
  prompt: 'Build it',
  phase,
  ...extra,
})

suite('Harness step channel', () => {
  test('plan → approve → execute → complete', async () => {
    const ch = new StepChannel(() => ({ skills: [{ slug: 'api-design', name: 'API design' }] }))
    const plan = ch.enqueue(dispatch('plan'))
    const next = await ch.poll('r1', 10)
    assert.strictEqual(next.action, 'plan')
    assert.deepStrictEqual('skills' in next ? next.skills.map((s) => s.slug) : [], ['api-design'])
    ch.submitPlan('r1', 's1', 'Add GET /menu')
    assert.strictEqual((await plan).response, 'Add GET /menu')

    const exec = ch.enqueue(dispatch('execute', 's1', { approvedPlan: 'Add GET /menu' }))
    const step = await ch.poll('r1', 10)
    assert.strictEqual(step.action, 'execute')
    assert.throws(() => ch.submitPlan('r1', 's1', 'again'), /not waiting for a plan/)
    ch.complete('r1', 's1', 'Done', { skillsUsed: ['api-design'] })
    assert.strictEqual((await exec).response, 'Done')
  })

  test('waiting, then done after finish', async () => {
    const ch = new StepChannel(undefined, () => 'approval')
    const w = await ch.poll('r1', 5)
    assert.strictEqual(w.action, 'waiting')
    assert.strictEqual('reason' in w ? w.reason : '', 'approval')
    const pending = ch.enqueue(dispatch('plan'))
    ch.finish('r1', 'stopped', 'cancelled')
    await assert.rejects(pending, /cancelled/)
    assert.strictEqual((await ch.poll('r1', 5)).action, 'stopped')
  })

  test('an aborted dispatch is rejected', async () => {
    const ch = new StepChannel()
    const ac = new AbortController()
    const p = ch.enqueue(dispatch('plan', 's1', { signal: ac.signal }))
    ac.abort()
    await assert.rejects(p)
  })
})

suite('Harness hooks', () => {
  test('Claude Code tool, skill and subagent hooks', () => {
    const edit = normalizeClaudeCode({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } })
    assert.deepStrictEqual(edit.map((e) => e.type), ['tool.called', 'file.changed'])
    assert.strictEqual(normalizeClaudeCode({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'x' } })[0].type, 'skill.used')
    assert.strictEqual(normalizeClaudeCode({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'planner' } })[0].agentType, 'planner')
    assert.strictEqual(normalizeClaudeCode({ hook_event_name: 'PostToolUse', tool_name: 'mcp__sdlc__sdlc_next_step', tool_input: {} }).length, 0)
  })

  test('secrets and excluded paths never leave the machine', () => {
    assert.ok(!redact('Authorization: Bearer abc123 password=hunter2').includes('abc123'))
    assert.ok(!redact('password=hunter2').includes('hunter2'))
    const env = normalizeClaudeCode({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '.env' } }, (p) => p !== '.env')
    assert.ok(!env.some((e) => e.path === '.env'))
  })
})

suite('Harness session files', () => {
  test('orchestrator prompt carries the run marker and the protocol for the tier', () => {
    const input = {
      runId: 'r1',
      storyKey: 'PAY-2',
      storyTitle: 'Menu',
      workflowName: 'Story delivery',
      steps: [{ label: 'Plan', agentName: 'Planner', skills: ['api-design'] }],
      sessionDir: '.sdlc/sessions/PAY-2',
      tier: 'full' as const,
    }
    assert.ok(orchestratorMarkdown(input).includes('[sdlc:run=r1]'))
    assert.ok(orchestratorMarkdown(input).includes('sdlc_next_step'))
    assert.ok(orchestratorMarkdown({ ...input, tier: 'files' }).includes('next.md'))
    assert.ok(launchPrompt(input).startsWith('[sdlc:run=r1]'))
  })

  test('merging keeps the user’s settings and replaces only our old hooks', () => {
    const base = {
      enabledMcpjsonServers: ['other'],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }, { hooks: [{ type: 'command', command: 'curl http://127.0.0.1:1/hooks/old/claude-code' }] }] },
    }
    const add = { enabledMcpjsonServers: ['sdlc'], hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl http://127.0.0.1:2/hooks/new/claude-code' }] }] } }
    const merged = mergeJson(base, add) as typeof base
    assert.deepStrictEqual(merged.enabledMcpjsonServers, ['other', 'sdlc'])
    const commands = merged.hooks.Stop.map((h) => h.hooks[0].command)
    assert.deepStrictEqual(commands, ['echo mine', 'curl http://127.0.0.1:2/hooks/new/claude-code'])
  })

  test('after the run, only our entries are taken out again', () => {
    const user = { enabledMcpjsonServers: ['other'], hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, mcpServers: { mine: { url: 'x' } } }
    const add = {
      enabledMcpjsonServers: ['sdlc'],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl http://127.0.0.1:2/hooks/new/claude-code' }] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'curl http://127.0.0.1:2/hooks/new/claude-code' }] }] },
      mcpServers: { sdlc: { type: 'http', url: 'http://127.0.0.1:2/mcp/t' } },
    }
    assert.deepStrictEqual(unmergeJson(mergeJson(user, add), add), user)
    // A file that only ever held our entries ends up empty (and is deleted).
    assert.deepStrictEqual(unmergeJson(mergeJson({}, add), add), {})
    const toml = 'model = "x"\n\n[mcp_servers.sdlc]\nurl = "u"\n\n[other]\na = 1\n'
    const out = removeTomlSection(toml, '[mcp_servers.sdlc]')
    assert.ok(!out.includes('sdlc') && out.includes('[other]') && out.includes('model = "x"'))
    assert.strictEqual(removeTomlSection('[mcp_servers.sdlc]\nurl = "u"\n', '[mcp_servers.sdlc]').trim(), '')
  })

  test('TOML: one section replaced, the rest untouched', () => {
    const text = 'model = "x"\n\n[mcp_servers.sdlc]\nurl = "old"\n\n[other]\na = 1\n'
    const out = upsertTomlSection(text, '[mcp_servers.sdlc]', '[mcp_servers.sdlc]\nurl = "new"\n')
    assert.ok(out.includes('url = "new"') && !out.includes('url = "old"') && out.includes('[other]') && out.includes('model = "x"'))
    assert.ok(upsertTomlSection('', '[s]', '[s]\na = 1\n').startsWith('[s]'))
  })
})

suite('Default harnesses', () => {
  test('Claude Code and Codex are the defaults, and match the extension pack', () => {
    assert.deepStrictEqual(DEFAULT_HARNESSES.map((h) => h.extensionId), ['anthropic.claude-code', 'openai.chatgpt'])
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { extensionPack?: string[] }
    assert.deepStrictEqual(pkg.extensionPack, DEFAULT_HARNESSES.map((h) => h.extensionId))
  })

  test('only the missing ones are installed', () => {
    assert.deepStrictEqual(missingDefaults(() => true), [])
    assert.deepStrictEqual(missingDefaults((id) => id === 'anthropic.claude-code').map((h) => h.id), ['codex'])
    assert.strictEqual(missingDefaults(() => false).length, 2)
  })
})
