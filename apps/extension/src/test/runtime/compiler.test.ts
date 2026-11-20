// Phase 4 — compiler unit tests. InternalAgent[] -> WorkflowSpec, sequential + handoff shapes.

import * as assert from 'assert'
import type { InternalAgent } from '../../discovery/agentModel'
import { internalAgentToSpec, type HandoffRoute } from '../../runtime/compile/internalAgentToSpec'
import { specToGraph } from '../../runtime/compile/specToGraph'
import { findTrigger, parseGraph, successors } from '../../runtime/graph'

function agent(name: string): InternalAgent {
  return {
    id: `claude-agent:.claude/agents/${name}.md#${name}`,
    name,
    description: `${name} agent`,
    instructions: `You are ${name}.`,
    tools: [],
    sourceKind: 'claude-agent',
    sourcePath: `.claude/agents/${name}.md`,
    raw: '',
    status: 'valid',
    issues: [],
  }
}

suite('Phase 4 — compiler', () => {
  test('sequential: trigger → (agent → gate)* → end, linearly linked', () => {
    const spec = internalAgentToSpec([agent('Designer'), agent('Implementer')], {
      name: 'demo',
      pattern: 'sequential',
      stepForAgent: (_a, i) => (i === 0 ? 'design' : 'implement'),
    })

    assert.strictEqual(spec.pattern, 'sequential')
    // 1 trigger + 2 agents + 2 gates + 1 end
    assert.strictEqual(spec.nodes.length, 6)
    assert.strictEqual(spec.nodes.filter((n) => n.kind === 'agent').length, 2)
    assert.strictEqual(spec.nodes.filter((n) => n.kind === 'gate').length, 2)

    // First agent gated at design, second at implement.
    const agents = spec.nodes.filter((n) => n.kind === 'agent')
    assert.strictEqual(agents[0].data.sdlcStep, 'design')
    assert.strictEqual(agents[1].data.sdlcStep, 'implement')
  })

  test('every agent is reached directly from its entry point — approval is intrinsic to the AGENT node at runtime, not a compiled node', () => {
    const spec = internalAgentToSpec([agent('Risky')], { name: 'demo' })
    assert.strictEqual(spec.nodes.filter((n) => n.kind === 'approval').length, 0)
    assert.ok(spec.edges.some((e) => e.source === 'trigger' && e.target === 'agent_0'))
  })

  test('gateAfterAgent:false omits gate nodes', () => {
    const spec = internalAgentToSpec([agent('A')], { name: 'demo', gateAfterAgent: false })
    assert.strictEqual(spec.nodes.filter((n) => n.kind === 'gate').length, 0)
  })

  test('handoff: emits condition nodes routing between agents', () => {
    const routes: HandoffRoute[] = [
      { fromAgentIndex: 0, toAgentIndex: 1, predicate: 'Local.DesignerOutput = "FEATURE"' },
      { fromAgentIndex: 0, toAgentIndex: 2, predicate: '' }, // ELSE fallthrough
    ]
    const spec = internalAgentToSpec([agent('Designer'), agent('FeaturePath'), agent('BugPath')], {
      name: 'demo',
      pattern: 'handoff',
      gateAfterAgent: false,
      routes,
    })
    const conds = spec.nodes.filter((n) => n.kind === 'condition')
    assert.strictEqual(conds.length, 2)
    assert.ok(conds.some((c) => c.data.branch === 'IF'))
    assert.ok(conds.some((c) => c.data.branch === 'ELSE'))
  })

  test('specToGraph produces a parseable graph with a discoverable trigger', () => {
    const spec = internalAgentToSpec([agent('A'), agent('B')], { name: 'demo' })
    const { nodes, edges } = specToGraph(spec)
    const graph = parseGraph(nodes, edges)
    const trigger = findTrigger(graph)
    assert.ok(trigger)
    assert.strictEqual(trigger!.type, 'TRIGGER')
    // trigger has exactly one successor (the first agent).
    assert.strictEqual(successors(graph, trigger!.id).length, 1)
  })

  test('rejects zero agents', () => {
    assert.throws(() => internalAgentToSpec([], { name: 'demo' }))
  })
})
