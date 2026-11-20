// Dedupe + normalize unit tests (Phase 2 exit criterion 3).

import * as assert from 'assert'
import { dedupe } from '../../discovery/dedupe'
import { normalize } from '../../discovery/normalizer'
import { buildAgent } from '../../discovery/validator'
import type { InternalAgent, SourceKind } from '../../discovery/agentModel'

function make(name: string, kind: SourceKind, path: string): InternalAgent {
  return buildAgent({
    sourceKind: kind,
    sourcePath: path,
    raw: '',
    name,
    description: 'd',
    instructions: 'body',
    tools: [],
  })
}

suite('Discovery — dedupe & normalize', () => {
  test('same agent in two conventions collapses to the higher-priority source', () => {
    const input = [
      make('Reviewer', 'agents-md', 'AGENTS.md'),
      make('Reviewer', 'claude-agent', '.claude/agents/reviewer.md'),
    ]
    const out = dedupe(input)
    assert.strictEqual(out.length, 1)
    assert.strictEqual(out[0].sourceKind, 'claude-agent') // wins by priority
    assert.deepStrictEqual(out[0].alsoSeenIn, ['agents-md'])
  })

  test('distinct agents are preserved', () => {
    const input = [make('A', 'claude-agent', 'a.md'), make('B', 'claude-agent', 'b.md')]
    assert.strictEqual(dedupe(input).length, 2)
  })

  test('skipped/unnamed manifests are never merged away', () => {
    const skipped1 = buildAgent({ sourceKind: 'agent-yaml', sourcePath: 'x/agent.yaml', raw: '', name: '', description: '', instructions: '', tools: [], malformed: true })
    const skipped2 = buildAgent({ sourceKind: 'agent-yaml', sourcePath: 'y/agent.yaml', raw: '', name: '', description: '', instructions: '', tools: [], malformed: true })
    assert.strictEqual(dedupe([skipped1, skipped2]).length, 2)
  })

  test('normalize sorts by source kind then name', () => {
    const out = normalize([
      make('Zebra', 'claude-agent', 'z.md'),
      make('Apple', 'claude-agent', 'a.md'),
      make('Copilot', 'copilot-instructions', '.github/copilot-instructions.md'),
    ])
    assert.strictEqual(out[0].name, 'Apple')
    assert.strictEqual(out[1].name, 'Zebra')
    assert.strictEqual(out[2].sourceKind, 'copilot-instructions')
  })

  test('byKind keeps an agent and a skill that share a name', () => {
    const input = [make('Reviewer', 'claude-agent', '.claude/agents/reviewer.md'), make('Reviewer', 'claude-skill', '.claude/skills/reviewer/SKILL.md')]
    assert.strictEqual(dedupe(input).length, 1)
    assert.strictEqual(dedupe(input, { byKind: true }).length, 2)
  })
})
