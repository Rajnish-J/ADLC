// Unit tests for the Claude Code prompt builder — node ordering and step rendering.

import * as assert from 'assert'
import { buildClaudeCodePrompt } from '../../chat/claudeCodeSeed'
import type { InternalAgent } from '../../discovery/agentModel'
import type { WorkflowSpec } from '../../runtime/spec'

function agent(id: string, name: string, instructions: string): InternalAgent {
  return {
    id,
    name,
    description: name,
    instructions,
    tools: [],
    sourceKind: 'claude-agent',
    sourcePath: `.claude/agents/${name}.md`,
    raw: '',
    status: 'valid',
    issues: [],
  }
}

const SPEC: WorkflowSpec = {
  specVersion: 1,
  name: 'Demo Pipeline',
  description: 'A demo.',
  pattern: 'sequential',
  nodes: [
    { id: 't', kind: 'trigger', label: 'Trigger', data: { triggerType: 'issue' } },
    { id: 'a1', kind: 'agent', label: 'Implementer', data: { agentId: 'agent:impl', agentName: 'Implementer' } },
    { id: 'g1', kind: 'gate', label: 'Gate', data: { gateStep: 'implement' } },
    { id: 'a2', kind: 'agent', label: 'Reviewer', data: { agentId: 'agent:rev', agentName: 'Reviewer' } },
    { id: 'ap', kind: 'approval', label: 'Approve', data: { question: 'Ship it?' } },
    { id: 'end', kind: 'end', label: 'End', data: {} },
  ],
  // Declared deliberately out of array order to prove BFS ordering from the trigger.
  edges: [
    { source: 'a1', target: 'g1' },
    { source: 't', target: 'a1' },
    { source: 'g1', target: 'a2' },
    { source: 'a2', target: 'ap' },
    { source: 'ap', target: 'end' },
  ],
  budget: { maxSteps: 50, timeoutMs: 300000 },
}

suite('Claude Code seed — buildClaudeCodePrompt', () => {
  const byId = new Map<string, InternalAgent>([
    ['agent:impl', agent('agent:impl', 'Implementer', 'Write the code to satisfy the work item.')],
    ['agent:rev', agent('agent:rev', 'Reviewer', 'Review the implementation for correctness.')],
  ])

  test('includes the task, workflow name, and resolved agent instructions', () => {
    const out = buildClaudeCodePrompt(SPEC, '# Story #42: Add login', byId)
    assert.ok(out.includes('# SDLC Workflow: Demo Pipeline'))
    assert.ok(out.includes('# Story #42: Add login'))
    assert.ok(out.includes('Write the code to satisfy the work item.'))
    assert.ok(out.includes('Review the implementation for correctness.'))
  })

  test('orders steps by graph traversal, not array order', () => {
    const out = buildClaudeCodePrompt(SPEC, 'task', byId)
    const impl = out.indexOf('Implementer')
    const gate = out.indexOf('Quality gate')
    const rev = out.indexOf('Reviewer')
    const appr = out.indexOf('Approval — Ship it?')
    assert.ok(impl < gate && gate < rev && rev < appr, `unexpected order: ${impl},${gate},${rev},${appr}`)
  })

  test('renders a placeholder when an agent id cannot be resolved', () => {
    const out = buildClaudeCodePrompt(SPEC, 'task', new Map())
    assert.ok(out.includes('no instructions found for this agent'))
  })
})
