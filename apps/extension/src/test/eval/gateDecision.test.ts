// Phase 3 — gate decision unit tests. The enforcement core: a failing required
// evaluator must block; errored/missing results must fail closed by default.

import * as assert from 'assert'
import { decideGate } from '../../eval/gateDecision'
import type { EvalScore, StepPolicy } from '../../eval/types'

const STEP: StepPolicy = {
  evaluators: ['builtin.task_adherence', 'builtin.tool_call_accuracy', 'builtin.coherence'],
  required: ['builtin.task_adherence', 'builtin.tool_call_accuracy'],
  thresholds: {
    'builtin.task_adherence': 3,
    'builtin.tool_call_accuracy': 3,
    'builtin.coherence': 2,
  },
}

function score(evaluator: string, s: number | null, errored = 0): EvalScore {
  return { evaluator, score: s, passed: s === null ? 0 : 1, failed: 0, errored }
}

suite('Eval — gate decision', () => {
  test('passes when all required evaluators meet threshold', () => {
    const d = decideGate(
      [score('builtin.task_adherence', 4), score('builtin.tool_call_accuracy', 3), score('builtin.coherence', 1)],
      STEP,
      true,
    )
    assert.strictEqual(d.pass, true)
  })

  test('fails when a required evaluator is below threshold', () => {
    const d = decideGate(
      [score('builtin.task_adherence', 2), score('builtin.tool_call_accuracy', 5)],
      STEP,
      true,
    )
    assert.strictEqual(d.pass, false)
    assert.ok(d.reason.includes('builtin.task_adherence'))
  })

  test('a failing non-required evaluator does not block the gate', () => {
    const d = decideGate(
      [score('builtin.task_adherence', 5), score('builtin.tool_call_accuracy', 4), score('builtin.coherence', 1)],
      STEP,
      true,
    )
    assert.strictEqual(d.pass, true)
  })

  test('errored required evaluator fails closed by default', () => {
    const d = decideGate(
      [score('builtin.task_adherence', 4, 2), score('builtin.tool_call_accuracy', 4)],
      STEP,
      true,
    )
    assert.strictEqual(d.pass, false)
  })

  test('errored evaluator passes when fail-open', () => {
    const d = decideGate(
      [score('builtin.task_adherence', 4, 2), score('builtin.tool_call_accuracy', 4)],
      STEP,
      false,
    )
    assert.strictEqual(d.pass, true)
  })

  test('missing required result fails closed', () => {
    const d = decideGate([score('builtin.tool_call_accuracy', 4)], STEP, true)
    const missing = d.perEvaluator.find((p) => p.evaluator === 'builtin.task_adherence')
    assert.strictEqual(missing?.pass, false)
    assert.strictEqual(d.pass, false)
  })

  test('null threshold is informational and never blocks', () => {
    const step: StepPolicy = { evaluators: ['x'], required: ['x'], thresholds: {} }
    const d = decideGate([score('x', 0)], step, true)
    assert.strictEqual(d.pass, true)
  })

  test('counts fallback: no numeric score, all rows passed → pass', () => {
    const step: StepPolicy = { evaluators: ['x'], required: ['x'], thresholds: { x: 3 } }
    const s: EvalScore = { evaluator: 'x', score: null, passed: 5, failed: 0, errored: 0 }
    assert.strictEqual(decideGate([s], step, true).pass, true)
  })

  test('counts fallback: no numeric score, a row failed → fail', () => {
    const step: StepPolicy = { evaluators: ['x'], required: ['x'], thresholds: { x: 3 } }
    const s: EvalScore = { evaluator: 'x', score: null, passed: 4, failed: 1, errored: 0 }
    assert.strictEqual(decideGate([s], step, true).pass, false)
  })

  test('lower-is-better (severity): passes when score ≤ threshold', () => {
    const step: StepPolicy = {
      evaluators: ['builtin.violence'],
      required: ['builtin.violence'],
      thresholds: { 'builtin.violence': 3 },
    }
    const lower = new Set(['builtin.violence'])
    // severity 2 ≤ 3 → pass (a "higher is better" gate would have failed this)
    assert.strictEqual(decideGate([score('builtin.violence', 2)], step, true, lower).pass, true)
    // severity 5 > 3 → fail
    const fail = decideGate([score('builtin.violence', 5)], step, true, lower)
    assert.strictEqual(fail.pass, false)
    assert.ok(fail.perEvaluator[0].reason.includes('>'))
  })
})
