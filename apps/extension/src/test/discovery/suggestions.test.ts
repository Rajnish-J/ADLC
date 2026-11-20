// Quality suggestions unit tests — pure, no `vscode`.

import * as assert from 'assert'
import {
  DEFAULT_QUALITY_RULES,
  evaluateSuggestions,
  parseQualityRules,
  type QualityRules,
} from '../../discovery/suggestions'
import { buildAgent } from '../../discovery/validator'
import type { InternalAgent, SourceKind } from '../../discovery/agentModel'

function make(overrides: Partial<{
  name: string
  description: string
  instructions: string
  tools: string[]
  model?: string
  kind: SourceKind
  malformed: boolean
  hasBundledScripts: boolean
}> = {}): InternalAgent {
  return buildAgent({
    sourceKind: overrides.kind ?? 'claude-agent',
    sourcePath: '.claude/agents/x.md',
    raw: '',
    name: overrides.name ?? 'Good Agent',
    description:
      overrides.description ??
      'A thorough agent. Triggers on "do the thing" and similar requests.',
    instructions:
      overrides.instructions ??
      'You are a careful agent. Follow the steps precisely and explain your reasoning at each stage of the task.',
    tools: overrides.tools ?? ['Read', 'Edit'],
    model: overrides.model,
    malformed: overrides.malformed,
    hasBundledScripts: overrides.hasBundledScripts,
  })
}

const ids = (s: ReturnType<typeof evaluateSuggestions>): string[] => s.map((x) => x.ruleId).sort()

suite('Discovery — quality suggestions', () => {
  test('a well-formed agent gets no suggestions under defaults', () => {
    assert.deepStrictEqual(evaluateSuggestions(make(), DEFAULT_QUALITY_RULES), [])
  })

  test('thin description and body are both flagged', () => {
    // The quoted phrase satisfies the trigger check so only the two length checks fire.
    const agent = make({ description: '"go"', instructions: 'tiny' })
    assert.deepStrictEqual(
      ids(evaluateSuggestions(agent, DEFAULT_QUALITY_RULES)),
      ['minDescriptionLength', 'minInstructionsLength'].sort(),
    )
  })

  test('missing trigger cue is flagged when description is otherwise long enough', () => {
    const agent = make({
      description: 'This agent quietly reformats files and never explains itself at all.',
    })
    const result = ids(evaluateSuggestions(agent, DEFAULT_QUALITY_RULES))
    assert.ok(result.includes('requireTriggerPhrases'))
    assert.ok(!result.includes('minDescriptionLength'))
  })

  test('skipped manifests produce no suggestions', () => {
    const agent = make({ malformed: true, name: '', description: '', instructions: '' })
    assert.strictEqual(agent.status, 'skipped')
    assert.deepStrictEqual(evaluateSuggestions(agent, DEFAULT_QUALITY_RULES), [])
  })

  test('rules can require tools and a model; custom messages are used', () => {
    const rules: QualityRules = {
      ...DEFAULT_QUALITY_RULES,
      requireToolsDeclared: true,
      requireModel: true,
      messages: { requireToolsDeclared: 'Add tools!' },
    }
    const agent = make({ tools: [], model: undefined })
    const result = evaluateSuggestions(agent, rules)
    const toolsSug = result.find((s) => s.ruleId === 'requireToolsDeclared')
    assert.strictEqual(toolsSug?.message, 'Add tools!')
    assert.ok(result.some((s) => s.ruleId === 'requireModel'))
  })

  test('a zero threshold disables its check', () => {
    const rules: QualityRules = { ...DEFAULT_QUALITY_RULES, minDescriptionLength: 0 }
    const agent = make({ description: 'x' })
    assert.ok(!ids(evaluateSuggestions(agent, rules)).includes('minDescriptionLength'))
  })

  suite('parseQualityRules', () => {
    test('parses a partial file and fills the rest from defaults', () => {
      const rules = parseQualityRules('minDescriptionLength: 200\nrequireModel: true\n')
      assert.strictEqual(rules.minDescriptionLength, 200)
      assert.strictEqual(rules.requireModel, true)
      assert.strictEqual(rules.minInstructionsLength, DEFAULT_QUALITY_RULES.minInstructionsLength)
    })

    test('malformed YAML falls back to defaults', () => {
      assert.deepStrictEqual(parseQualityRules(':\n  - ['), DEFAULT_QUALITY_RULES)
    })

    test('ignores unknown message keys and negative numbers', () => {
      const rules = parseQualityRules(
        'minDescriptionLength: -5\nmessages:\n  bogus: hi\n  requireModel: "Pin it"\n',
      )
      assert.strictEqual(rules.minDescriptionLength, DEFAULT_QUALITY_RULES.minDescriptionLength)
      assert.strictEqual(rules.messages.requireModel, 'Pin it')
      assert.ok(!('bogus' in rules.messages))
    })
  })
})
