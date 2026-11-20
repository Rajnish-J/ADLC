// Phase 5B — Control Plane pure-logic tests: guardrail compliance evaluation.

import * as assert from 'assert'
import {
  evaluateCompliance,
  type GuardrailPolicy,
  type RegisteredAgent,
} from '../../foundry/controlPlane'

const policy: GuardrailPolicy = {
  id: 'p1',
  name: 'baseline',
  version: '1',
  requiredGuardrails: ['content-safety', 'pii-redaction'],
}

function agent(name: string, guardrails: string[]): RegisteredAgent {
  return { name, version: '1', appliedGuardrails: guardrails }
}

suite('Phase 5B — Control Plane compliance', () => {
  test('flags an agent missing a required guardrail', () => {
    const result = evaluateCompliance([agent('partial', ['content-safety'])], policy)
    assert.strictEqual(result[0].compliant, false)
    assert.deepStrictEqual(result[0].missing, ['pii-redaction'])
  })

  test('an agent with all required guardrails is compliant', () => {
    const result = evaluateCompliance([agent('full', ['content-safety', 'pii-redaction', 'extra'])], policy)
    assert.strictEqual(result[0].compliant, true)
    assert.deepStrictEqual(result[0].missing, [])
  })

  test('an agent with no guardrails is missing all required', () => {
    const result = evaluateCompliance([agent('bare', [])], policy)
    assert.strictEqual(result[0].compliant, false)
    assert.deepStrictEqual(result[0].missing, ['content-safety', 'pii-redaction'])
  })

  test('an empty policy makes every agent trivially compliant', () => {
    const empty: GuardrailPolicy = { ...policy, requiredGuardrails: [] }
    const result = evaluateCompliance([agent('any', [])], empty)
    assert.strictEqual(result[0].compliant, true)
  })
})
