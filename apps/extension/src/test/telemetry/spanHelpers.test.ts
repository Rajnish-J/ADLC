// Phase 3 — span helper tests. The critical assertion is the privacy guard:
// content attributes must be ABSENT unless recordContent is explicitly true.

import * as assert from 'assert'
import { buildEvaluatorSpanAttributes, buildRunSpanAttributes } from '../../telemetry/spanHelpers'
import type { EvalRunResult, GateDecision } from '../../eval/types'

const RESULT: EvalRunResult = {
  evalId: 'e1',
  runId: 'r1',
  status: 'completed',
  scores: [],
  usage: { tokensIn: 10, tokensOut: 5 },
}
const DECISION: GateDecision = {
  pass: true,
  reason: 'all required evaluators passed',
  perEvaluator: [{ evaluator: 'builtin.coherence', score: 4, threshold: 2, required: true, pass: true, reason: '' }],
}

suite('Telemetry — span attributes', () => {
  test('emits GenAI + SDLC convention attributes', () => {
    const a = buildRunSpanAttributes({
      result: RESULT,
      decision: DECISION,
      step: 'review',
      judgeDeployment: 'gpt-4o',
      recordContent: false,
    })
    assert.strictEqual(a['gen_ai.system'], 'az.ai.foundry')
    assert.strictEqual(a['gen_ai.operation.name'], 'evaluate')
    assert.strictEqual(a['gen_ai.request.model'], 'gpt-4o')
    assert.strictEqual(a['gen_ai.usage.input_tokens'], 10)
    assert.strictEqual(a['sdlc.gate.decision'], 'pass')
    assert.strictEqual(a['sdlc.step'], 'review')
  })

  test('PRIVACY: no content attributes when recordContent is false', () => {
    const a = buildRunSpanAttributes({
      result: RESULT,
      decision: DECISION,
      step: 'review',
      judgeDeployment: 'gpt-4o',
      recordContent: false,
      content: { prompt: 'secret', completion: 'also secret' },
    })
    assert.strictEqual('gen_ai.prompt' in a, false)
    assert.strictEqual('gen_ai.completion' in a, false)
  })

  test('content attributes present only when explicitly opted in', () => {
    const a = buildRunSpanAttributes({
      result: RESULT,
      decision: DECISION,
      step: 'review',
      judgeDeployment: 'gpt-4o',
      recordContent: true,
      content: { prompt: 'p', completion: 'c' },
    })
    assert.strictEqual(a['gen_ai.prompt'], 'p')
    assert.strictEqual(a['gen_ai.completion'], 'c')
  })

  test('evaluator span omits score when null', () => {
    const withScore = buildEvaluatorSpanAttributes('x', 3, true)
    assert.strictEqual(withScore['sdlc.evaluator.score'], 3)
    const noScore = buildEvaluatorSpanAttributes('x', null, false)
    assert.strictEqual('sdlc.evaluator.score' in noScore, false)
    assert.strictEqual(noScore['sdlc.evaluator.pass'], false)
  })
})
