// Phase 3 — dataset builder + sampling tests. The dataset is what the SDK run
// and the ADO task share, so its shape is load-bearing.

import * as assert from 'assert'
import { applySampling, buildDataset, requiresResponse } from '../../eval/datasetBuilder'
import { buildAgent } from '../../discovery/validator'
import type { GatePolicy } from '../../eval/types'
import type { InternalAgent } from '../../discovery/agentModel'

function agent(name: string, tools: string[] = []): InternalAgent {
  return buildAgent({
    sourceKind: 'claude-agent',
    sourcePath: `.claude/agents/${name}.md`,
    raw: '',
    name,
    description: `${name} does things`,
    instructions: 'body',
    tools,
  })
}

const POLICY: GatePolicy = {
  judgeDeployment: 'gpt-4o',
  sampling: { strategy: 'none' },
  failClosedOnError: true,
  steps: {
    review: {
      evaluators: ['builtin.task_adherence', 'builtin.coherence'],
      required: ['builtin.task_adherence'],
      thresholds: { 'builtin.task_adherence': 3, 'builtin.coherence': 2 },
    },
  },
}

suite('Eval — dataset builder', () => {
  test('emits evaluators, data rows, mapping, and parameters for the step', () => {
    const ds = buildDataset([agent('Reviewer')], POLICY, { step: 'review', name: 'sdlc-review-123' })
    assert.strictEqual(ds.name, 'sdlc-review-123')
    assert.deepStrictEqual(ds.evaluators, ['builtin.task_adherence', 'builtin.coherence'])
    assert.strictEqual(ds.data.length, 1)
    assert.ok(typeof ds.data[0].query === 'string')
    assert.strictEqual(ds.data[0].sdlc_agent_id, 'claude-agent:.claude/agents/Reviewer.md#reviewer')
    assert.strictEqual(ds.data_mapping?.query, '{{item.query}}')
    assert.strictEqual(ds.evaluator_parameters.deployment_name, 'gpt-4o')
    assert.deepStrictEqual(ds.evaluator_parameters['builtin.task_adherence'], { threshold: 3 })
  })

  test('omits response unless a pre-recorded one is supplied', () => {
    const a = agent('Reviewer')
    const without = buildDataset([a], POLICY, { step: 'review', name: 'n' })
    assert.strictEqual('response' in without.data[0], false)
    const withResp = buildDataset([a], POLICY, {
      step: 'review',
      name: 'n',
      responsesByAgentId: { [a.id]: 'the response' },
    })
    assert.strictEqual(withResp.data[0].response, 'the response')
  })

  test('unknown step yields an empty evaluator set', () => {
    const ds = buildDataset([agent('X')], POLICY, { step: 'design', name: 'n' })
    assert.deepStrictEqual(ds.evaluators, [])
  })

  test('per-evaluator mapping omits tool_definitions for non-tool evaluators', () => {
    const a = agent('Reviewer')
    const ds = buildDataset([a], POLICY, {
      step: 'review',
      name: 'n',
      responsesByAgentId: { [a.id]: 'resp' },
    })
    // coherence does not consume tool_definitions; task_adherence (non-tool) neither.
    assert.deepStrictEqual(ds.dataMappings?.['builtin.coherence'], {
      query: '{{item.query}}',
      response: '{{item.response}}',
    })
    assert.strictEqual(
      'tool_definitions' in (ds.dataMappings?.['builtin.task_adherence'] ?? {}),
      false,
    )
  })

  test('every evaluator that supports tool_definitions maps it; rows carry synthesized defs', () => {
    const a = agent('Builder', ['Read', 'Write'])
    const toolPolicy: GatePolicy = {
      ...POLICY,
      steps: {
        implement: {
          // task_adherence only *optionally* supports tool_definitions, but once a
          // sibling (tool_call_accuracy) puts the field in the data, Azure requires
          // it mapped here too. coherence does not support it and must NOT map it.
          evaluators: ['builtin.task_adherence', 'builtin.tool_call_accuracy', 'builtin.coherence'],
          required: ['builtin.tool_call_accuracy'],
          thresholds: {
            'builtin.task_adherence': 3,
            'builtin.tool_call_accuracy': 3,
            'builtin.coherence': 2,
          },
        },
      },
    }
    const ds = buildDataset([a], toolPolicy, {
      step: 'implement',
      name: 'n',
      responsesByAgentId: { [a.id]: 'resp' },
    })
    assert.strictEqual(
      ds.dataMappings?.['builtin.tool_call_accuracy']?.tool_definitions,
      '{{item.tool_definitions}}',
    )
    assert.strictEqual(
      ds.dataMappings?.['builtin.task_adherence']?.tool_definitions,
      '{{item.tool_definitions}}',
    )
    assert.strictEqual(
      'tool_definitions' in (ds.dataMappings?.['builtin.coherence'] ?? {}),
      false,
    )
    const defs = ds.data[0].tool_definitions as Array<{ type: string; function: { name: string } }>
    assert.strictEqual(defs.length, 2)
    assert.strictEqual(defs[0].type, 'function')
    assert.deepStrictEqual(
      defs.map((d) => d.function.name),
      ['Read', 'Write'],
    )
  })

  test('rows omit tool_definitions when no evaluator needs them', () => {
    const a = agent('Builder', ['Read'])
    const ds = buildDataset([a], POLICY, { step: 'review', name: 'n' })
    assert.strictEqual('tool_definitions' in ds.data[0], false)
  })

  test('requiresResponse is true for response-scoring evaluators, false otherwise', () => {
    assert.strictEqual(requiresResponse(['builtin.coherence']), true)
    assert.strictEqual(requiresResponse(['builtin.intent_resolution']), true)
    assert.strictEqual(requiresResponse([]), false)
    assert.strictEqual(requiresResponse(['builtin.some_custom_evaluator']), false)
  })
})

suite('Eval — sampling', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ i }))

  test('none keeps everything', () => {
    assert.strictEqual(applySampling(rows, { strategy: 'none' }).length, 10)
  })

  test('headN slices the first n', () => {
    assert.strictEqual(applySampling(rows, { strategy: 'headN', n: 3 }).length, 3)
  })

  test('ratio keeps ceil(ratio*len) but never below minRows', () => {
    assert.strictEqual(applySampling(rows, { strategy: 'ratio', ratio: 0.25, minRows: 5 }).length, 5)
    assert.strictEqual(applySampling(rows, { strategy: 'ratio', ratio: 0.5, minRows: 1 }).length, 5)
  })

  test('ratio never exceeds available rows', () => {
    assert.strictEqual(applySampling(rows, { strategy: 'ratio', ratio: 1, minRows: 50 }).length, 10)
  })
})
