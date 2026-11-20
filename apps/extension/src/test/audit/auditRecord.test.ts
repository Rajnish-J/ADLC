// Phase 3 — audit record tests: one record per evaluator, JSONL round-trip,
// usage recorded once, gate decision denormalized onto every row.

import * as assert from 'assert'
import { buildAuditRecords, fromJsonl, toJsonl } from '../../audit/auditRecord'
import type { EvalRunResult, GateDecision } from '../../eval/types'

const RESULT: EvalRunResult = {
  evalId: 'eval_1',
  runId: 'run_1',
  status: 'completed',
  reportUrl: 'https://ai.azure.com/eval/run_1',
  scores: [],
  usage: { tokensIn: 120, tokensOut: 30 },
}

const DECISION: GateDecision = {
  pass: false,
  reason: 'failed required: builtin.task_adherence',
  perEvaluator: [
    { evaluator: 'builtin.task_adherence', score: 2, threshold: 3, required: true, pass: false, reason: '2 < 3' },
    { evaluator: 'builtin.coherence', score: 4, threshold: 2, required: false, pass: true, reason: '4 ≥ 2' },
  ],
}

function build() {
  return buildAuditRecords({
    result: RESULT,
    decision: DECISION,
    step: 'review',
    actor: 'rajnish@synergech.com',
    source: 'extension',
    projectEndpoint: 'https://acct.services.ai.azure.com/api/projects/p',
    timestamp: '2026-06-03T10:00:00.000Z',
    agentId: 'claude-agent:.claude/agents/reviewer.md#reviewer',
  })
}

suite('Audit — record builder', () => {
  test('emits one record per evaluator', () => {
    const records = build()
    assert.strictEqual(records.length, 2)
    assert.strictEqual(records[0].evaluator, 'builtin.task_adherence')
  })

  test('overall gate decision is denormalized onto every record', () => {
    for (const r of build()) {
      assert.strictEqual(r.gateDecision, 'fail')
      assert.strictEqual(r.gateReason, 'failed required: builtin.task_adherence')
    }
  })

  test('usage is recorded on the first record only', () => {
    const records = build()
    assert.strictEqual(records[0].tokensIn, 120)
    assert.strictEqual(records[0].tokensOut, 30)
    assert.strictEqual(records[1].tokensIn, 0)
    assert.strictEqual(records[1].tokensOut, 0)
  })

  test('JSONL round-trips', () => {
    const r = build()[0]
    const parsed = fromJsonl(toJsonl(r))
    assert.deepStrictEqual(parsed, r)
  })

  test('fromJsonl tolerates blank/garbage lines', () => {
    assert.strictEqual(fromJsonl(''), null)
    assert.strictEqual(fromJsonl('not json'), null)
  })
})
