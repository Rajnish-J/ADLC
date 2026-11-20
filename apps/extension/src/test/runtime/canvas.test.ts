// Phase 5A — canvas pure-logic tests: specToFlow mapping, Dagre layout, and run-overlay derivation.
// All framework-free (no vscode, no webview) — the same functions the webview consumes.

import * as assert from 'assert'
import type { InternalAgent } from '../../discovery/agentModel'
import { internalAgentToSpec } from '../../runtime/compile/internalAgentToSpec'
import { specToFlow, runStateToOverlay } from '../../runtime/canvas/specToFlow'
import { layoutWorkflow } from '../../runtime/layout/workflowLayout'
import type { RunState } from '../../runtime/port'

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

suite('Phase 5A — canvas mapping', () => {
  test('specToFlow maps every spec node to a flow node with type = kind', () => {
    const spec = internalAgentToSpec([agent('Designer'), agent('Implementer')], {
      name: 'demo',
      pattern: 'sequential',
    })
    const { nodes, edges } = specToFlow(spec)

    assert.strictEqual(nodes.length, spec.nodes.length)
    assert.strictEqual(edges.length, spec.edges.length)
    for (const n of nodes) {
      const src = spec.nodes.find((s) => s.id === n.id)
      assert.ok(src, `flow node ${n.id} has a source spec node`)
      assert.strictEqual(n.type, src.kind)
      assert.strictEqual(n.data.kind, src.kind)
    }
  })

  test('specToFlow assigns every node a position (left-to-right, distinct ranks)', () => {
    const spec = internalAgentToSpec([agent('A'), agent('B')], { name: 'demo' })
    const { nodes } = specToFlow(spec)
    const byId = new Map(nodes.map((n) => [n.id, n]))

    // Trigger sits left of the end node (LR layout).
    const trigger = byId.get('trigger')
    const end = byId.get('end')
    assert.ok(trigger && end)
    assert.ok(trigger.position.x < end.position.x, 'trigger is left of end')
    for (const n of nodes) assert.ok(Number.isFinite(n.position.x) && Number.isFinite(n.position.y))
  })

  test('layoutWorkflow skips edges referencing unknown nodes without throwing', () => {
    const pos = layoutWorkflow({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'ghost' },
      ],
    })
    assert.strictEqual(pos.size, 2)
    assert.ok(pos.has('a') && pos.has('b'))
  })

  test('runStateToOverlay reflects the latest step status and gate decision per node', () => {
    const run: RunState = {
      runId: 'r1',
      workflowName: 'demo',
      status: 'failed',
      actor: 'tester',
      inputs: {},
      startedAt: 0,
      steps: [
        { id: 's1', nodeId: 'agent_0', kind: 'agent', label: 'A', seq: 1, status: 'succeeded', startedAt: 0 },
        {
          id: 's2',
          nodeId: 'gate_0',
          kind: 'gate',
          label: 'Gate',
          seq: 2,
          status: 'blocked',
          startedAt: 0,
          gateDecision: { pass: false, perEvaluator: [], reason: 'below threshold' },
        },
      ],
    }
    const overlay = runStateToOverlay(run)
    assert.strictEqual(overlay['agent_0'].status, 'succeeded')
    assert.strictEqual(overlay['gate_0'].status, 'blocked')
    assert.strictEqual(overlay['gate_0'].gate?.pass, false)
    assert.strictEqual(overlay['gate_0'].gate?.reason, 'below threshold')
  })

  test('runStateToOverlay: last step for a repeated node id wins (goto loops)', () => {
    const run: RunState = {
      runId: 'r2',
      workflowName: 'demo',
      status: 'running',
      actor: 'tester',
      inputs: {},
      startedAt: 0,
      steps: [
        { id: 's1', nodeId: 'agent_0', kind: 'agent', label: 'A', seq: 1, status: 'succeeded', startedAt: 0 },
        { id: 's2', nodeId: 'agent_0', kind: 'agent', label: 'A', seq: 2, status: 'running', startedAt: 0 },
      ],
    }
    assert.strictEqual(runStateToOverlay(run)['agent_0'].status, 'running')
  })

  test('runStateToOverlay surfaces live activity only while the step is running (Phase 4 — LangGraph introspection)', () => {
    const running: RunState = {
      runId: 'r3',
      workflowName: 'demo',
      status: 'running',
      actor: 'tester',
      inputs: {},
      startedAt: 0,
      steps: [
        {
          id: 's1',
          nodeId: 'agent_0',
          kind: 'agent',
          label: 'A',
          seq: 1,
          status: 'running',
          startedAt: 0,
          activity: { thought: 'thinking about the plan…', liveTokensOut: 12, updatedAt: 5 },
        },
      ],
    }
    const runningOverlay = runStateToOverlay(running)
    assert.strictEqual(runningOverlay['agent_0'].activity?.thought, 'thinking about the plan…')
    assert.strictEqual(runningOverlay['agent_0'].activity?.liveTokensOut, 12)

    // Once the step finishes, stale activity must not linger on the overlay.
    const finished: RunState = {
      ...running,
      steps: [{ ...running.steps[0], status: 'succeeded', output: 'done', finishedAt: 10 }],
    }
    assert.strictEqual(runStateToOverlay(finished)['agent_0'].activity, undefined)
  })
})
