// Pure-logic tests for the Foundry agent adapters: stable id format and the AgentSummary /
// InternalAgent-like conversions used by the builder and the run-time resolver.

import * as assert from 'assert'
import {
  foundryAgentId,
  toAgentSummary,
  toInternalAgentLike,
  type FoundryAgent,
} from '../../foundry/foundryAgents'

const FA: FoundryAgent = {
  id: foundryAgentId('https://acct.services.ai.azure.com/api/projects/p', 'triage', '2'),
  name: 'triage',
  description: 'Triages bugs',
  instructions: 'You are a triage agent.',
  model: 'gpt-4o',
  version: '2',
}

suite('Foundry agents — adapters', () => {
  test('id encodes endpoint and name@version, trimming a trailing slash', () => {
    const id = foundryAgentId('https://acct.services.ai.azure.com/api/projects/p/', 'triage', '2')
    assert.strictEqual(id, 'azure_foundry:https://acct.services.ai.azure.com/api/projects/p#triage@2')
  })

  test('toAgentSummary tags sourceKind azure_foundry and carries instructions', () => {
    const s = toAgentSummary(FA)
    assert.strictEqual(s.sourceKind, 'azure_foundry')
    assert.strictEqual(s.id, FA.id)
    assert.strictEqual(s.name, 'triage')
    assert.strictEqual(s.model, 'gpt-4o')
    assert.strictEqual(s.instructions, 'You are a triage agent.')
  })

  test('toInternalAgentLike preserves id/instructions/model for dispatch', () => {
    const a = toInternalAgentLike(FA)
    assert.strictEqual(a.id, FA.id)
    assert.strictEqual(a.instructions, 'You are a triage agent.')
    assert.strictEqual(a.model, 'gpt-4o')
    assert.strictEqual(a.status, 'valid')
    assert.deepStrictEqual(a.tools, [])
  })
})
