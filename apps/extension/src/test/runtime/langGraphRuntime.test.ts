// Phase 4 (LangGraph) — LangGraphWorkflowRuntime tests. Mirrors mockRuntime.test.ts's exact cases so the
// two runtimes stay directly comparable (same StubAgentDispatcher/StubGateEvaluator, same deterministic
// clock pattern), plus a checkpointer-restart case specific to the LangGraph engine's durability upgrade.

import * as assert from 'assert'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import type { InternalAgent } from '../../discovery/agentModel'
import { internalAgentToSpec } from '../../runtime/compile/internalAgentToSpec'
import { InMemoryRunMetaPort, LangGraphWorkflowRuntime } from '../../runtime/langgraph/langGraphRuntime'
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

function runtime(scripted: Record<string, string> = {}): LangGraphWorkflowRuntime {
  let t = 1000
  return new LangGraphWorkflowRuntime({
    dispatcher: new StubAgentDispatcher(scripted),
    gate: new StubGateEvaluator(),
    checkpointer: new MemorySaver(),
    runMeta: new InMemoryRunMetaPort(),
    now: () => (t += 1), // monotonic, deterministic
  })
}

/** Every agent node is mandatory HITL — approve every pending plan until the run settles. */
async function approveAllAgents(
  rt: LangGraphWorkflowRuntime,
  state: RunState,
  actor = 'approver@x',
): Promise<RunState> {
  let s = state
  while (s.status === 'awaiting_approval') {
    s = await rt.submitApproval(s.runId, { approve: true, actor })
  }
  return s
}

suite('Phase 4 (LangGraph) — LangGraphWorkflowRuntime', () => {
  test('(1) multi-agent sequential workflow runs to completion, attributable to the actor', async () => {
    const spec = internalAgentToSpec([agent('Designer'), agent('Implementer')], { name: 'demo' })
    const rt = runtime()
    let state = await rt.startRun({ spec, inputs: { task: 'build a thing' }, actor: 'rajnish@synergech.com' })
    state = await approveAllAgents(rt, state)

    assert.strictEqual(state.status, 'completed')
    assert.strictEqual(state.actor, 'rajnish@synergech.com')
    assert.strictEqual(state.steps.filter((s) => s.kind === 'agent' && s.status === 'succeeded').length, 2)
    assert.strictEqual(state.steps.filter((s) => s.kind === 'gate' && s.status === 'succeeded').length, 2)
    assert.ok(state.steps.filter((s) => s.kind === 'gate').every((s) => s.gateDecision?.pass === true))
  })

  test('gate halt-on-fail: a failing step blocks the run before the next agent', async () => {
    const spec = internalAgentToSpec([agent('Designer'), agent('Implementer')], { name: 'demo' })
    const rt = runtime({ Designer: 'this design will FAIL review' })
    let state = await rt.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })
    assert.strictEqual(state.status, 'awaiting_approval')
    state = await rt.submitApproval(state.runId, { approve: true, actor: 'approver@x' })

    assert.strictEqual(state.status, 'failed')
    assert.ok(state.error && state.error.toLowerCase().includes('gate'))
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

  test('handoff routes to the matching branch by agent output (real conditional-edge routing)', async () => {
    const spec = internalAgentToSpec([agent('Router'), agent('FeaturePath'), agent('BugPath')], {
      name: 'demo',
      pattern: 'handoff',
      gateAfterAgent: false,
      routes: [
        { fromAgentIndex: 0, toAgentIndex: 1, predicate: 'Local.RouterOutput = "FEATURE"' },
        { fromAgentIndex: 0, toAgentIndex: 2, predicate: '' },
      ],
    })
    const rt = runtime({ Router: 'FEATURE' })
    let state = await rt.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })
    state = await approveAllAgents(rt, state)

    assert.strictEqual(state.status, 'completed')
    assert.ok(state.steps.some((s) => s.label === 'FeaturePath' && s.status === 'succeeded'))
    assert.ok(!state.steps.some((s) => s.label === 'BugPath'))
  })

  test('a paused run survives recompilation from persisted checkpoint + run metadata (restart durability)', async () => {
    const spec = internalAgentToSpec([agent('A')], { name: 'demo' })
    const checkpointer = new MemorySaver()
    const runMeta = new InMemoryRunMetaPort()
    let t = 1000
    const deps = {
      dispatcher: new StubAgentDispatcher(),
      gate: new StubGateEvaluator(),
      checkpointer,
      runMeta,
      now: () => (t += 1),
    }
    const rt1 = new LangGraphWorkflowRuntime(deps)
    const paused = await rt1.startRun({ spec, inputs: { task: 'x' }, actor: 'u' })
    assert.strictEqual(paused.status, 'awaiting_approval')

    // Simulate an extension-host restart: a brand-new runtime instance sharing only the durable
    // checkpointer + run-meta store (as extension.ts would wire them from globalStorageUri-backed stores).
    const rt2 = new LangGraphWorkflowRuntime(deps)
    const reloaded = await rt2.getRun(paused.runId)
    assert.strictEqual(reloaded?.status, 'awaiting_approval')
    assert.ok(reloaded?.pendingApproval?.plan)

    const completed = await rt2.submitApproval(paused.runId, { approve: true, actor: 'approver@x' })
    assert.strictEqual(completed.status, 'completed')
  })
})
