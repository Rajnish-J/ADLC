// Phase 4 — MockWorkflowRuntime tests. Maps directly to the plan's exit criteria:
//   (1) multi-agent workflow runs to completion; (2) every agent pauses for mandatory plan approval
//   and resumes on approve, or halts the whole run on reject; (3) loop hits max-step budget and stops
//   with a clear reason; (4) runs are attributable + audited.

import * as assert from 'assert'
import type { InternalAgent } from '../../discovery/agentModel'
import { internalAgentToSpec } from '../../runtime/compile/internalAgentToSpec'
import { MockWorkflowRuntime } from '../../runtime/mock/mockRuntime'
import { StubAgentDispatcher, StubGateEvaluator } from '../../runtime/mock/stubs'
import type { RunState } from '../../runtime/port'
import type { WorkflowSpec } from '../../runtime/spec'

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

function runtime(scripted: Record<string, string> = {}): MockWorkflowRuntime {
  let t = 1000
  return new MockWorkflowRuntime({
    dispatcher: new StubAgentDispatcher(scripted),
    gate: new StubGateEvaluator(),
    now: () => (t += 1), // monotonic, deterministic
  })
}

/** Every agent node is mandatory HITL — approve every pending plan until the run settles. */
async function approveAllAgents(
  rt: MockWorkflowRuntime,
  state: RunState,
  actor = 'approver@x',
): Promise<RunState> {
  let s = state
  while (s.status === 'awaiting_approval') {
    s = await rt.submitApproval(s.runId, { approve: true, actor })
  }
  return s
}

suite('Phase 4 — MockWorkflowRuntime', () => {
  test('(1) multi-agent sequential workflow runs to completion, attributable to the actor', async () => {
    const spec = internalAgentToSpec([agent('Designer'), agent('Implementer')], { name: 'demo' })
    const rt = runtime()
    let state = await rt.startRun({ spec, inputs: { task: 'build a thing' }, actor: 'rajnish@synergech.com' })
    state = await approveAllAgents(rt, state)

    assert.strictEqual(state.status, 'completed')
    assert.strictEqual(state.actor, 'rajnish@synergech.com')
    // 2 agent steps + 2 gate steps.
    assert.strictEqual(state.steps.filter((s) => s.kind === 'agent' && s.status === 'succeeded').length, 2)
    assert.strictEqual(state.steps.filter((s) => s.kind === 'gate' && s.status === 'succeeded').length, 2)
    // Every gate step carries an enforcing decision.
    assert.ok(state.steps.filter((s) => s.kind === 'gate').every((s) => s.gateDecision?.pass === true))
  })

  test('gate halt-on-fail: a failing step blocks the run before the next agent', async () => {
    // Designer's execute-phase output contains "FAIL" → StubGateEvaluator fails the design gate.
    const spec = internalAgentToSpec([agent('Designer'), agent('Implementer')], { name: 'demo' })
    const rt = runtime({ Designer: 'this design will FAIL review' })
    let state = await rt.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })
    assert.strictEqual(state.status, 'awaiting_approval')
    state = await rt.submitApproval(state.runId, { approve: true, actor: 'approver@x' })

    assert.strictEqual(state.status, 'failed')
    assert.ok(state.error && state.error.toLowerCase().includes('gate'))
    // The implementer agent must NOT have run.
    assert.strictEqual(state.steps.filter((s) => s.label === 'Implementer').length, 0)
    const blocked = state.steps.find((s) => s.kind === 'gate' && s.status === 'blocked')
    assert.ok(blocked?.gateDecision && blocked.gateDecision.pass === false)
  })

  test('(2) every agent pauses for a mandatory plan approval and resumes on approve', async () => {
    const spec = internalAgentToSpec([agent('Designer'), agent('Implementer')], { name: 'demo' })
    const rt = runtime()
    let state = await rt.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })

    assert.strictEqual(state.status, 'awaiting_approval')
    assert.ok(state.pendingApproval?.plan, 'the generated plan is surfaced for human review')
    assert.strictEqual(state.steps.filter((s) => s.label === 'Implementer').length, 0)

    state = await rt.submitApproval(state.runId, { approve: true, actor: 'approver@x' })
    // Sequential: Implementer is a second, distinct agent node — it pauses too before it's out.
    assert.strictEqual(state.status, 'awaiting_approval')
    state = await rt.submitApproval(state.runId, { approve: true, actor: 'approver@x' })

    assert.strictEqual(state.status, 'completed')
    assert.strictEqual(state.steps.filter((s) => s.label === 'Implementer' && s.status === 'succeeded').length, 1)
  })

  test('plan rejection halts the whole run without executing the agent', async () => {
    const spec = internalAgentToSpec([agent('Designer'), agent('Implementer')], { name: 'demo' })
    const rt = runtime()
    const paused = await rt.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })
    const rejected = await rt.submitApproval(paused.runId, { approve: false, actor: 'approver@x', comment: 'no' })

    assert.strictEqual(rejected.status, 'failed')
    assert.ok(rejected.error?.includes('rejected'))
    assert.strictEqual(rejected.steps.filter((s) => s.label === 'Designer' && s.status === 'succeeded').length, 0)
    assert.strictEqual(rejected.steps.filter((s) => s.label === 'Implementer').length, 0)
  })

  test('agent dispatch is two-phase: a plan is generated and surfaced before execution', async () => {
    const spec = internalAgentToSpec([agent('A')], { name: 'demo' })
    const rt = runtime()
    const paused = await rt.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })

    assert.strictEqual(paused.status, 'awaiting_approval')
    const planningStep = paused.steps.find((s) => s.label === 'A')
    assert.ok(planningStep?.plan?.includes('plan'))
    assert.ok(!planningStep?.output, 'no execution output before approval')

    const completed = await rt.submitApproval(paused.runId, { approve: true, actor: 'approver@x' })
    assert.strictEqual(completed.status, 'completed')
    const finished = completed.steps.find((s) => s.label === 'A')
    assert.ok(finished?.output?.includes('processed'))
  })

  test('(3) a goto loop hits the max-step budget and stops with a clear reason', async () => {
    // Hand-built spec with a self-loop via goto; budget caps it.
    const spec: WorkflowSpec = {
      specVersion: 1,
      name: 'looper',
      description: '',
      pattern: 'sequential',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', data: {} },
        { id: 'loop', kind: 'goto', label: 'Loop', data: { targetId: 'loop' } },
      ],
      edges: [{ source: 'trigger', target: 'loop' }],
      budget: { maxSteps: 5, timeoutMs: 60_000 },
    }
    const rt = runtime()
    const state = await rt.startRun({ spec, actor: 'u' })

    assert.strictEqual(state.status, 'failed')
    assert.ok(state.error?.includes('max-step') || state.error?.toLowerCase().includes('node executions'))
  })

  test('(4) every step transition is observable via onRunUpdate', async () => {
    const spec = internalAgentToSpec([agent('A')], { name: 'demo' })
    const rt = runtime()
    const statuses: string[] = []
    const off = rt.onRunUpdate((s) => statuses.push(s.status))
    const paused = await rt.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })
    await rt.submitApproval(paused.runId, { approve: true, actor: 'approver@x' })
    off()
    assert.ok(statuses.includes('running'))
    assert.ok(statuses.includes('awaiting_approval'))
    assert.ok(statuses.includes('completed'))
  })

  test('cancel on a paused run marks it cancelled', async () => {
    const spec = internalAgentToSpec([agent('A'), agent('B')], { name: 'demo' })
    const rt = runtime()
    const paused = await rt.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })
    assert.strictEqual(paused.status, 'awaiting_approval')
    const cancelled = await rt.cancelRun(paused.runId)
    assert.strictEqual(cancelled.status, 'cancelled')
  })

  test('handoff routes to the matching branch by agent output', async () => {
    const spec = internalAgentToSpec([agent('Router'), agent('FeaturePath'), agent('BugPath')], {
      name: 'demo',
      pattern: 'handoff',
      gateAfterAgent: false,
      routes: [
        { fromAgentIndex: 0, toAgentIndex: 1, predicate: 'Local.RouterOutput = "FEATURE"' },
        { fromAgentIndex: 0, toAgentIndex: 2, predicate: '' },
      ],
    })
    // Router outputs exactly "FEATURE" → first branch.
    const rt = runtime({ Router: 'FEATURE' })
    let state = await rt.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })
    state = await approveAllAgents(rt, state)

    assert.strictEqual(state.status, 'completed')
    assert.ok(state.steps.some((s) => s.label === 'FeaturePath' && s.status === 'succeeded'))
    assert.ok(!state.steps.some((s) => s.label === 'BugPath'))
  })
})
