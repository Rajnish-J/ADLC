// The default workflow ("Story delivery", @sdlc/core) — the same spec the SDLC platform seeds into every project
// and the extension serves as its read-only local default. Structure checks, plus an end-to-end run of the exact
// production spec through the LangGraph engine: every agent's plan approval, both approval steps and the quality
// gate, to completion.

import * as assert from 'assert'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { STORY_DELIVERY_ID, STORY_DELIVERY_SPEC } from '@sdlc/core'
import { InMemoryRunMetaPort, LangGraphWorkflowRuntime } from '../../runtime/langgraph/langGraphRuntime'
import { StubAgentDispatcher, StubGateEvaluator } from '../../runtime/mock/stubs'

const AGENT_STEPS: Array<[nodeId: string, slug: string]> = [
  ['plan', 'planner'],
  ['implement', 'implementer'],
  ['test', 'tester'],
  ['review', 'reviewer'],
  ['pr-description', 'pr-author'],
]

suite('Default workflow — Story delivery', () => {
  test('is the platform skeleton: trigger → 5 agents, 2 approvals, 1 gate → end, as one chain', () => {
    const spec = STORY_DELIVERY_SPEC
    assert.strictEqual(spec.name, 'Story delivery')
    assert.strictEqual(STORY_DELIVERY_ID, 'story-delivery')
    assert.deepStrictEqual(
      spec.nodes.map((n) => n.kind),
      ['trigger', 'agent', 'approval', 'agent', 'agent', 'gate', 'agent', 'agent', 'approval', 'end'],
    )
    for (const [nodeId, slug] of AGENT_STEPS) {
      const node = spec.nodes.find((n) => n.id === nodeId)
      assert.strictEqual(node?.data.agentId, slug, `${nodeId} must be bound to the built-in "${slug}" agent`)
    }
    assert.strictEqual(spec.edges.length, spec.nodes.length - 1)
    spec.edges.forEach((e, i) => {
      assert.strictEqual(e.source, spec.nodes[i].id)
      assert.strictEqual(e.target, spec.nodes[i + 1].id)
    })
  })

  test('runs end to end: every agent and approval step, then the gate, to completion', async () => {
    let t = 1000
    const rt = new LangGraphWorkflowRuntime({
      dispatcher: new StubAgentDispatcher(),
      gate: new StubGateEvaluator(),
      checkpointer: new MemorySaver(),
      runMeta: new InMemoryRunMetaPort(),
      now: () => (t += 1),
    })

    let state = await rt.startRun({ spec: STORY_DELIVERY_SPEC, inputs: { task: 'Reset a forgotten password.' }, actor: 'dev@example.com' })
    let approvals = 0
    while (state.status === 'awaiting_approval') {
      state = await rt.submitApproval(state.runId, { approve: true, actor: 'lead@example.com' })
      approvals += 1
      assert.ok(approvals < 50, 'run did not converge')
    }

    assert.strictEqual(state.status, 'completed', state.error)
    assert.ok(approvals >= 2, 'both approval steps paused the run')
    for (const [nodeId] of AGENT_STEPS) {
      assert.strictEqual(state.steps.find((s) => s.nodeId === nodeId)?.status, 'succeeded', `${nodeId} did not succeed`)
    }
    assert.strictEqual(state.steps.find((s) => s.nodeId === 'quality-gate')?.status, 'succeeded', 'the quality gate did not pass')
  })
})
