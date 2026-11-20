// Phase 3 — gate policy resolution tests. Workspace file overrides config
// overrides built-in defaults; thresholds deep-merge.

import * as assert from 'assert'
import { resolveGatePolicy } from '../../eval/gatePolicy'

suite('Eval — gate policy resolution', () => {
  test('built-in defaults apply with no overrides', () => {
    const p = resolveGatePolicy(undefined, undefined)
    assert.strictEqual(p.judgeDeployment, 'gpt-4o')
    assert.strictEqual(p.sampling.strategy, 'ratio')
    assert.strictEqual(p.failClosedOnError, true)
    assert.ok(p.steps.review)
  })

  test('config defaults override built-ins', () => {
    const p = resolveGatePolicy(undefined, {
      judgeDeployment: 'gpt-4o-mini',
      failClosedOnError: false,
      sampling: { strategy: 'headN', n: 3 },
    })
    assert.strictEqual(p.judgeDeployment, 'gpt-4o-mini')
    assert.strictEqual(p.failClosedOnError, false)
    assert.strictEqual(p.sampling.strategy, 'headN')
    assert.strictEqual(p.sampling.n, 3)
  })

  test('workspace file overrides config', () => {
    const p = resolveGatePolicy(
      { judgeDeployment: 'judge-prod', steps: { review: { thresholds: { 'builtin.coherence': 5 } } } },
      { judgeDeployment: 'gpt-4o-mini' },
    )
    assert.strictEqual(p.judgeDeployment, 'judge-prod')
    // threshold overridden, but evaluators/required inherited from defaults
    assert.strictEqual(p.steps.review?.thresholds['builtin.coherence'], 5)
    assert.ok(p.steps.review?.evaluators.includes('builtin.task_adherence'))
  })

  test('workspace can introduce a custom step', () => {
    const p = resolveGatePolicy({
      steps: { release: { evaluators: ['builtin.x'], required: ['builtin.x'], thresholds: { 'builtin.x': 4 } } },
    })
    assert.deepStrictEqual(p.steps.release?.evaluators, ['builtin.x'])
  })

  test('defaultThresholds fill gaps without clobbering explicit ones', () => {
    const p = resolveGatePolicy(undefined, { defaultThresholds: { 'builtin.coherence': 1, 'builtin.new': 2 } })
    // explicit default (3 for review coherence) wins over fallback
    assert.strictEqual(p.steps.review?.thresholds['builtin.coherence'], 3)
    assert.strictEqual(p.steps.review?.thresholds['builtin.new'], 2)
  })
})
