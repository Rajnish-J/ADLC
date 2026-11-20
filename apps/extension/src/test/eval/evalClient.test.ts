// Phase 3 — eval request-body builder tests. These guard the exact shape sent to
// the OpenAI-compatible evals API; a wrong initialization_parameters shape makes
// every row report `errored`, so it's load-bearing.

import * as assert from 'assert'
import { buildEvalCreateBody, initParamsForEvaluator } from '../../eval/evalClient'
import type { EvalDataset } from '../../eval/types'

const DATASET: EvalDataset = {
  name: 'sdlc-review-1',
  evaluators: ['builtin.task_adherence', 'builtin.coherence'],
  data: [{ query: 'q', response: 'r' }],
  data_mapping: { query: '{{item.query}}', response: '{{item.response}}' },
  dataMappings: {
    'builtin.task_adherence': { query: '{{item.query}}', response: '{{item.response}}' },
    'builtin.coherence': { query: '{{item.query}}', response: '{{item.response}}' },
  },
  evaluator_parameters: {
    deployment_name: 'gpt-4o',
    'builtin.task_adherence': { threshold: 3 },
    'builtin.coherence': { threshold: 2 },
  },
}

suite('Eval — initialization parameters', () => {
  test('passes only the evaluator-owned params, not the whole blob', () => {
    const init = initParamsForEvaluator('builtin.task_adherence', DATASET.evaluator_parameters)
    assert.deepStrictEqual(init, { deployment_name: 'gpt-4o', threshold: 3 })
    // sibling evaluator keys must NOT leak in as kwargs
    assert.strictEqual('builtin.coherence' in init, false)
  })

  test('omits threshold when the evaluator has none', () => {
    const init = initParamsForEvaluator('builtin.intent_resolution', DATASET.evaluator_parameters)
    assert.deepStrictEqual(init, { deployment_name: 'gpt-4o' })
  })

  test('omits deployment_name for safety evaluators (hosted safety service)', () => {
    const init = initParamsForEvaluator('builtin.violence', {
      deployment_name: 'gpt-4o',
      'builtin.violence': { threshold: 3 },
    })
    assert.deepStrictEqual(init, { threshold: 3 })
    assert.strictEqual('deployment_name' in init, false)
  })
})

suite('Eval — create body', () => {
  test('each criterion gets its own per-evaluator initialization_parameters', () => {
    const body = buildEvalCreateBody(DATASET)
    const criteria = body.testing_criteria as Array<Record<string, unknown>>
    assert.strictEqual(criteria.length, 2)
    assert.deepStrictEqual(criteria[0].initialization_parameters, {
      deployment_name: 'gpt-4o',
      threshold: 3,
    })
    assert.deepStrictEqual(criteria[1].initialization_parameters, {
      deployment_name: 'gpt-4o',
      threshold: 2,
    })
    assert.strictEqual(criteria[0].type, 'azure_ai_evaluator')
    assert.strictEqual(criteria[0].evaluator_name, 'builtin.task_adherence')
  })

  test('declares tool_definitions in the item schema', () => {
    const body = buildEvalCreateBody(DATASET)
    const schema = (body.data_source_config as Record<string, unknown>).item_schema as Record<
      string,
      unknown
    >
    const props = schema.properties as Record<string, unknown>
    assert.ok('tool_definitions' in props)
  })
})
