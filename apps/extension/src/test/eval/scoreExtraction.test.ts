// Phase 3 — score/usage extraction tests against a canned evals-run response.
// Guards the single point that absorbs preview-shape drift.

import * as assert from 'assert'
import {
  extractErrorSamples,
  extractReportUrl,
  extractScores,
  extractScoresFromOutputItems,
  extractUsage,
} from '../../eval/scoreExtraction'

const RUN_RESPONSE = {
  id: 'run_123',
  status: 'completed',
  report_url: 'https://ai.azure.com/eval/run_123',
  result_counts: { passed: 8, failed: 2, errored: 0, total: 10 },
  per_testing_criteria_results: [
    { testing_criteria: 'builtin.task_adherence', passed: 5, failed: 0, errored: 0 },
    { testing_criteria: 'builtin.coherence', passed: 3, failed: 2, errored: 0, score: 2.4 },
  ],
  per_model_usage: [
    { prompt_tokens: 100, completion_tokens: 40 },
    { input_tokens: 50, output_tokens: 10 },
  ],
}

suite('Eval — score extraction', () => {
  test('maps each testing criterion to an EvalScore', () => {
    const scores = extractScores(RUN_RESPONSE)
    assert.strictEqual(scores.length, 2)
    const ta = scores.find((s) => s.evaluator === 'builtin.task_adherence')
    assert.strictEqual(ta?.score, null)
    assert.strictEqual(ta?.passed, 5)
    const co = scores.find((s) => s.evaluator === 'builtin.coherence')
    assert.strictEqual(co?.score, 2.4)
    assert.strictEqual(co?.failed, 2)
  })

  test('sums usage across model entries (prompt/input + completion/output)', () => {
    const usage = extractUsage(RUN_RESPONSE)
    assert.strictEqual(usage.tokensIn, 150)
    assert.strictEqual(usage.tokensOut, 50)
  })

  test('extracts the report URL', () => {
    assert.strictEqual(extractReportUrl(RUN_RESPONSE), 'https://ai.azure.com/eval/run_123')
  })

  test('tolerates an empty/garbage response', () => {
    assert.deepStrictEqual(extractScores(undefined), [])
    assert.deepStrictEqual(extractUsage(null), { tokensIn: 0, tokensOut: 0 })
    assert.strictEqual(extractReportUrl({}), undefined)
  })
})

suite('Eval — error-sample extraction', () => {
  test('pulls distinct error messages from nested output items', () => {
    const resp = {
      data: [
        { id: 'i1', status: 'error', error: { message: 'DeploymentNotFound: gpt-4o' } },
        { id: 'i2', status: 'error', results: [{ sample: { error: 'judge timed out' } }] },
        { id: 'i3', status: 'error', error: { message: 'DeploymentNotFound: gpt-4o' } }, // dup
      ],
    }
    const samples = extractErrorSamples(resp)
    assert.deepStrictEqual(samples.sort(), ['DeploymentNotFound: gpt-4o', 'judge timed out'])
  })

  test('caps the number of samples', () => {
    const resp = {
      data: [
        { error: 'e1' },
        { error: 'e2' },
        { error: 'e3' },
        { error: 'e4' },
      ],
    }
    assert.strictEqual(extractErrorSamples(resp, 2).length, 2)
  })

  test('returns nothing when there are no errors', () => {
    assert.deepStrictEqual(extractErrorSamples({ data: [{ status: 'pass', score: 4 }] }), [])
    assert.deepStrictEqual(extractErrorSamples(undefined), [])
  })
})

suite('Eval — score aggregation from output items', () => {
  const OUTPUT_ITEMS = {
    data: [
      {
        results: [
          { name: 'builtin.coherence', score: 4, passed: true, status: 'completed' },
          { name: 'builtin.task_adherence', score: null, passed: true, status: 'completed' },
        ],
      },
      {
        results: [
          { name: 'builtin.coherence', score: 2, passed: false, status: 'completed' },
          { name: 'builtin.task_adherence', score: null, passed: false, status: 'completed' },
        ],
      },
    ],
  }

  test('means numeric scores and tallies pass/fail per evaluator', () => {
    const scores = extractScoresFromOutputItems(OUTPUT_ITEMS)
    const co = scores.find((s) => s.evaluator === 'builtin.coherence')
    assert.strictEqual(co?.score, 3) // mean of 4 and 2
    assert.strictEqual(co?.passed, 1)
    assert.strictEqual(co?.failed, 1)
    // boolean evaluator: no numeric score, but pass/fail counts survive
    const ta = scores.find((s) => s.evaluator === 'builtin.task_adherence')
    assert.strictEqual(ta?.score, null)
    assert.strictEqual(ta?.passed, 1)
    assert.strictEqual(ta?.failed, 1)
  })

  test('counts errored rows and excludes them from score mean', () => {
    const scores = extractScoresFromOutputItems({
      data: [
        { results: [{ name: 'builtin.coherence', score: 5, passed: true, status: 'completed' }] },
        { results: [{ name: 'builtin.coherence', status: 'error' }] },
      ],
    })
    const co = scores.find((s) => s.evaluator === 'builtin.coherence')
    assert.strictEqual(co?.score, 5)
    assert.strictEqual(co?.passed, 1)
    assert.strictEqual(co?.errored, 1)
  })

  test('tolerates an empty/garbage response', () => {
    assert.deepStrictEqual(extractScoresFromOutputItems(undefined), [])
    assert.deepStrictEqual(extractScoresFromOutputItems({}), [])
  })
})
