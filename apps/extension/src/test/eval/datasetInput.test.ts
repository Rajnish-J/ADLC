// Phase 6 — dataset wizard parsing tests (W-7).
// The pure core of the Evaluate dataset wizard: JSON/JSONL parsing, validation,
// and single-agent response derivation — no vscode interaction.

import * as assert from 'assert'
import {
  parsePastedRows,
  parseDatasetFile,
  responsesFor,
} from '../../eval/datasetInput'

suite('Eval — dataset input parsing', () => {
  test('parsePastedRows accepts a valid array of rows', () => {
    const r = parsePastedRows('[{"query":"hi","response":"hello"}]')
    assert.ok(r.ok)
    if (r.ok) {
      assert.strictEqual(r.rows.length, 1)
      assert.strictEqual(r.rows[0].query, 'hi')
    }
  })

  test('parsePastedRows rejects invalid JSON', () => {
    const r = parsePastedRows('[{query: hi}]')
    assert.strictEqual(r.ok, false)
    if (!r.ok) assert.match(r.error, /Invalid JSON/)
  })

  test('parsePastedRows rejects a non-array', () => {
    const r = parsePastedRows('{"query":"hi"}')
    assert.strictEqual(r.ok, false)
    if (!r.ok) assert.match(r.error, /array/)
  })

  test('parsePastedRows rejects an empty array', () => {
    const r = parsePastedRows('[]')
    assert.strictEqual(r.ok, false)
    if (!r.ok) assert.match(r.error, /empty/)
  })

  test('parsePastedRows rejects a row missing query', () => {
    const r = parsePastedRows('[{"response":"x"}]')
    assert.strictEqual(r.ok, false)
    if (!r.ok) assert.match(r.error, /query/)
  })

  test('parseDatasetFile parses a .jsonl file line-by-line', () => {
    const content = '{"query":"a"}\n\n{"query":"b","response":"y"}\n'
    const r = parseDatasetFile(content, '.jsonl')
    assert.ok(r.ok)
    if (r.ok) assert.strictEqual(r.rows.length, 2)
  })

  test('parseDatasetFile reports the offending .jsonl line', () => {
    const content = '{"query":"a"}\nnot json\n'
    const r = parseDatasetFile(content, '.jsonl')
    assert.strictEqual(r.ok, false)
    if (!r.ok) assert.match(r.error, /Line 2/)
  })

  test('parseDatasetFile accepts a .json array and a lone object', () => {
    const arr = parseDatasetFile('[{"query":"a"}]', '.json')
    assert.ok(arr.ok)

    const obj = parseDatasetFile('{"query":"solo"}', '.json')
    assert.ok(obj.ok)
    if (obj.ok) assert.strictEqual(obj.rows.length, 1)
  })

  test('responsesFor derives a single-agent response map from the first responded row', () => {
    const map = responsesFor('agent-1', [{ query: 'q' }, { query: 'q2', response: 'r2' }])
    assert.deepStrictEqual(map, { 'agent-1': 'r2' })
  })

  test('responsesFor returns undefined when no row has a response', () => {
    const map = responsesFor('agent-1', [{ query: 'q' }])
    assert.strictEqual(map, undefined)
  })
})
