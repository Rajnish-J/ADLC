// Phase 5C — Purview pure-logic tests: heuristic PII/SIT detection + classification record builder.

import * as assert from 'assert'
import { classifyHeuristic, buildClassificationRecord } from '../../foundry/purview'

suite('Phase 5C — Purview heuristic classification', () => {
  test('detects email, SSN, and IP in a synthetic payload', () => {
    const c = classifyHeuristic('Contact a@b.com, SSN 123-45-6789, host 10.0.0.1')
    assert.strictEqual(c.source, 'heuristic')
    assert.strictEqual(c.sensitive, true)
    const types = c.types.map((t) => t.type)
    assert.ok(types.includes('email'))
    assert.ok(types.includes('ssn'))
    assert.ok(types.includes('ip-address'))
  })

  test('clean text is not sensitive', () => {
    const c = classifyHeuristic('The quick brown fox jumps over the lazy dog.')
    assert.strictEqual(c.sensitive, false)
    assert.deepStrictEqual(c.types, [])
  })

  test('counts multiple matches of the same type', () => {
    const c = classifyHeuristic('a@b.com and c@d.org')
    const email = c.types.find((t) => t.type === 'email')
    assert.strictEqual(email?.count, 2)
  })

  test('buildClassificationRecord stamps timestamp + runId and preserves the verdict', () => {
    const c = classifyHeuristic('a@b.com')
    const rec = buildClassificationRecord(c, '2026-06-04T00:00:00.000Z', 'run-1')
    assert.strictEqual(rec.timestamp, '2026-06-04T00:00:00.000Z')
    assert.strictEqual(rec.runId, 'run-1')
    assert.strictEqual(rec.sensitive, true)
    assert.strictEqual(rec.source, 'heuristic')
  })
})
