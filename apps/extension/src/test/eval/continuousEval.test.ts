// Phase 5D — continuous-evaluation pure-logic tests: sampling, breach detection, spend alert, the
// RunState→sample mapping, and the pure alert-record builder. No vscode/SDK.

import * as assert from 'assert'
import {
  DEFAULT_CONTINUOUS_CONFIG,
  evaluateContinuous,
  inferenceTokensOf,
  runStatesToSamples,
  sampleRuns,
  type RunSample,
} from '../../eval/continuousEval'
import { buildAlertRecords } from '../../eval/alertSink'
import type { RunState } from '../../runtime/port'

function sample(runId: string, score: number | null, tokens = 0): RunSample {
  return {
    runId,
    scores: [{ evaluator: 'builtin.task_adherence', score, passed: 1, failed: 0, errored: 0 }],
    evalUsage: { tokensIn: tokens, tokensOut: 0 },
  }
}

suite('Phase 5D — continuous evaluation', () => {
  test('sampleRuns keeps at least minSamples and never exceeds the population', () => {
    const pop = Array.from({ length: 10 }, (_, i) => sample(`r${i}`, 0.9))
    assert.strictEqual(sampleRuns(pop, 0.25, 5).length, 5) // minSamples floor wins over 25%
    assert.strictEqual(sampleRuns(pop, 0.5, 2).length, 5) // 50% wins over floor
    assert.strictEqual(sampleRuns(pop.slice(0, 3), 0.25, 5).length, 3) // capped at population
    assert.strictEqual(sampleRuns([], 0.5, 5).length, 0)
  })

  test('evaluateContinuous raises a quality-regression alert below threshold', () => {
    const report = evaluateContinuous(
      [sample('good', 0.95), sample('bad', 0.4)],
      { ...DEFAULT_CONTINUOUS_CONFIG, alertThreshold: 0.7 },
      1000,
    )
    const regressions = report.alerts.filter((a) => a.kind === 'quality-regression')
    assert.strictEqual(regressions.length, 1)
    assert.strictEqual(regressions[0].runId, 'bad')
    assert.strictEqual(regressions[0].value, 0.4)
  })

  test('evaluateContinuous raises an eval-spend alert when over budget', () => {
    // 300 eval tokens vs 1000 inference = 0.30 > 0.15 budget.
    const report = evaluateContinuous(
      [sample('r1', 0.9, 300)],
      { ...DEFAULT_CONTINUOUS_CONFIG, evalSpendBudgetRatio: 0.15 },
      1000,
    )
    const spend = report.alerts.filter((a) => a.kind === 'eval-spend')
    assert.strictEqual(spend.length, 1)
    assert.ok(Math.abs(report.spendRatio - 0.3) < 1e-9)
  })

  test('no spend alert when within budget; null scores never breach', () => {
    const report = evaluateContinuous(
      [sample('r1', null, 50)],
      { ...DEFAULT_CONTINUOUS_CONFIG, alertThreshold: 0.7, evalSpendBudgetRatio: 0.15 },
      1000,
    )
    assert.strictEqual(report.alerts.length, 0)
  })

  test('runStatesToSamples maps gate decisions to scores; inferenceTokensOf sums agent tokens', () => {
    const run: RunState = {
      runId: 'r1',
      workflowName: 'demo',
      status: 'completed',
      actor: 'tester',
      inputs: {},
      startedAt: 0,
      steps: [
        { id: 's1', nodeId: 'agent_0', kind: 'agent', label: 'A', seq: 1, status: 'succeeded', startedAt: 0, tokensIn: 100, tokensOut: 50 },
        {
          id: 's2',
          nodeId: 'gate_0',
          kind: 'gate',
          label: 'Gate',
          seq: 2,
          status: 'succeeded',
          startedAt: 0,
          gateDecision: {
            pass: true,
            reason: 'ok',
            perEvaluator: [{ evaluator: 'builtin.coherence', score: 0.92, threshold: 0.7, required: true, pass: true, reason: 'ok' }],
          },
        },
      ],
    }
    const samples = runStatesToSamples([run])
    assert.strictEqual(samples.length, 1)
    assert.strictEqual(samples[0].scores[0].evaluator, 'builtin.coherence')
    assert.strictEqual(samples[0].scores[0].score, 0.92)
    assert.strictEqual(inferenceTokensOf([run]), 150)
  })

  test('buildAlertRecords stamps the supplied timestamp and preserves fields', () => {
    const records = buildAlertRecords(
      [{ kind: 'quality-regression', runId: 'bad', value: 0.4, threshold: 0.7, message: 'm' }],
      '2026-06-04T00:00:00.000Z',
    )
    assert.strictEqual(records.length, 1)
    assert.strictEqual(records[0].timestamp, '2026-06-04T00:00:00.000Z')
    assert.strictEqual(records[0].kind, 'quality-regression')
    assert.strictEqual(records[0].value, 0.4)
  })
})
