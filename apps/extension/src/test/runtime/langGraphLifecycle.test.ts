// Phase 4 (LangGraph) — lifecycle tests for the fixes that make the engine safe to be the default:
// every spec node kind through the compiled graph, parallel-safe counters/ids, live per-step streaming,
// real cancellation, finished-run cleanup, and restoring paused runs after a "restart".
//
// Pure (no `vscode`): runs under the VS Code test host AND under plain mocha, so it can be run in a second:
//   npm run compile-tests && npx mocha --ui tdd out/test/runtime/langGraphLifecycle.test.js

import * as assert from 'assert'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import type { InternalAgent } from '../../discovery/agentModel'
import { internalAgentToSpec } from '../../runtime/compile/internalAgentToSpec'
import {
  InMemoryRunMetaPort,
  LangGraphWorkflowRuntime,
  PAUSED_RUN_RETENTION_MS,
  type LangGraphRuntimeDeps,
} from '../../runtime/langgraph/langGraphRuntime'
import { StubAgentDispatcher, StubGateEvaluator } from '../../runtime/mock/stubs'
import type {
  AgentDispatcher,
  AgentDispatchInput,
  AgentDispatchResult,
  GateEvaluationInput,
  GateEvaluator,
  RunState,
} from '../../runtime/port'
import type { SpecNode, WorkflowSpec } from '../../runtime/spec'
import type { GateDecision } from '../../eval/types'

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

interface Rig {
  rt: LangGraphWorkflowRuntime
  deps: LangGraphRuntimeDeps
  checkpointer: MemorySaver
  runMeta: InMemoryRunMetaPort
}

/** A runtime plus the shared durable stores, so a second runtime over the same stores simulates a restart. */
function rig(overrides: Partial<LangGraphRuntimeDeps> = {}): Rig {
  let t = 1000
  const checkpointer = new MemorySaver()
  const runMeta = new InMemoryRunMetaPort()
  const deps: LangGraphRuntimeDeps = {
    dispatcher: new StubAgentDispatcher(),
    gate: new StubGateEvaluator(),
    checkpointer,
    runMeta,
    now: () => (t += 1),
    ...overrides,
  }
  return { rt: new LangGraphWorkflowRuntime(deps), deps, checkpointer, runMeta }
}

/** Another runtime over the SAME checkpointer/run-meta: what a reloaded extension host sees. */
function restarted(r: Rig): LangGraphWorkflowRuntime {
  return new LangGraphWorkflowRuntime({ ...r.deps })
}

async function approveAll(rt: LangGraphWorkflowRuntime, state: RunState): Promise<RunState> {
  let s = state
  while (s.status === 'awaiting_approval') s = await rt.submitApproval(s.runId, { approve: true, actor: 'approver@x' })
  return s
}

function spec(name: string, nodes: SpecNode[], edges: Array<[string, string]>, maxSteps = 50): WorkflowSpec {
  return {
    specVersion: 1,
    name,
    description: '',
    pattern: 'sequential',
    nodes: [{ id: 'trigger', kind: 'trigger', label: 'Start', data: {} }, ...nodes],
    edges: edges.map(([source, target]) => ({ source, target })),
    budget: { maxSteps, timeoutMs: 60_000 },
  }
}

const setVar = (id: string, variable: string, value: string): SpecNode => ({
  id,
  kind: 'set-variable',
  label: id,
  data: { variable, value },
})

/** Holds one dispatch phase open until released, so a node can be observed (or cancelled) mid-flight. */
class HoldingDispatcher implements AgentDispatcher {
  signalSeen: AbortSignal | undefined
  private release!: () => void
  private readonly held = new Promise<void>((resolve) => (this.release = resolve))
  private markStarted!: () => void
  readonly started = new Promise<void>((resolve) => (this.markStarted = resolve))

  constructor(private readonly holdPhase: 'plan' | 'execute') {}

  async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    if (input.phase === this.holdPhase) {
      this.signalSeen = input.signal
      this.markStarted()
      await this.held
    }
    return { response: `[${input.agentName}] ${input.phase} done`, tokensIn: 1, tokensOut: 1 }
  }

  releaseNow(): void {
    this.release()
  }
}

/** Rejects instead of hanging forever, so a regression fails with a message rather than a mocha timeout. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
  })
  // Clear the timer either way so a passing (or failing) test never keeps the process alive.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function hasThread(checkpointer: MemorySaver, runId: string): Promise<boolean> {
  return (await checkpointer.getTuple({ configurable: { thread_id: runId } })) !== undefined
}

suite('Phase 4 (LangGraph) — node kinds through the compiled graph', () => {
  test('approval node pauses, records the answer on approve, and halts the run on reject', async () => {
    const s = spec(
      'approval',
      [
        { id: 'ask', kind: 'approval', label: 'Ask', data: { question: 'Ship it?', approvalVar: 'Local.Ship' } },
        { id: 'end', kind: 'end', label: 'Done', data: {} },
      ],
      [
        ['trigger', 'ask'],
        ['ask', 'end'],
      ],
    )

    const approved = rig()
    const paused = await approved.rt.startRun({ spec: s, actor: 'u' })
    assert.strictEqual(paused.status, 'awaiting_approval')
    assert.strictEqual(paused.pendingApproval?.question, 'Ship it?')
    const done = await approved.rt.submitApproval(paused.runId, { approve: true, actor: 'boss@x' })
    assert.strictEqual(done.status, 'completed')
    assert.strictEqual(done.outputs?.['Local.Ship'], 'yes')
    assert.strictEqual(done.steps.find((st) => st.nodeId === 'ask')?.status, 'succeeded')

    const rejected = rig()
    const p2 = await rejected.rt.startRun({ spec: s, actor: 'u' })
    const failed = await rejected.rt.submitApproval(p2.runId, { approve: false, actor: 'boss@x', comment: 'not yet' })
    assert.strictEqual(failed.status, 'failed')
    assert.ok(failed.error?.includes('rejected by boss@x'))
    assert.strictEqual(failed.steps.find((st) => st.nodeId === 'ask')?.status, 'blocked')
  })

  test('set-variable evaluates its value and exposes it in the run outputs', async () => {
    const s = spec('setvar', [setVar('mode', 'Local.Mode', '="fast"')], [['trigger', 'mode']])
    const { rt } = rig()
    const state = await rt.startRun({ spec: s, actor: 'u' })
    assert.strictEqual(state.status, 'completed')
    assert.strictEqual(state.outputs?.['Local.Mode'], 'fast')
  })

  test('if / else-if / else conditions pick exactly one branch, by precedence', async () => {
    const branchSpec = (mode: string): WorkflowSpec =>
      spec(
        'branches',
        [
          setVar('mode', 'Local.Mode', `="${mode}"`),
          { id: 'c1', kind: 'condition', label: 'If slow', data: { branch: 'IF', predicate: 'Local.Mode = "slow"' } },
          { id: 'c2', kind: 'condition', label: 'Else if fast', data: { branch: 'ELSE_IF', predicate: 'Local.Mode = "fast"' } },
          { id: 'c3', kind: 'condition', label: 'Else', data: { branch: 'ELSE', predicate: '' } },
          setVar('bIf', 'Local.Branch', '="if"'),
          setVar('bElseIf', 'Local.Branch', '="elseif"'),
          setVar('bElse', 'Local.Branch', '="else"'),
        ],
        [
          ['trigger', 'mode'],
          ['mode', 'c1'],
          ['mode', 'c2'],
          ['mode', 'c3'],
          ['c1', 'bIf'],
          ['c2', 'bElseIf'],
          ['c3', 'bElse'],
        ],
      )

    for (const [mode, expected] of [
      ['slow', 'if'],
      ['fast', 'elseif'],
      ['other', 'else'],
    ] as const) {
      const state = await rig().rt.startRun({ spec: branchSpec(mode), actor: 'u' })
      assert.strictEqual(state.status, 'completed', `mode=${mode}`)
      assert.strictEqual(state.outputs?.['Local.Branch'], expected, `mode=${mode}`)
      const ran = state.steps.filter((st) => st.nodeId.startsWith('b')).map((st) => st.nodeId)
      assert.strictEqual(ran.length, 1, `exactly one branch node runs for mode=${mode}, got ${ran.join(',')}`)
    }
  })
})

suite('Phase 4 (LangGraph) — parallel branches', () => {
  const fanOut = (maxSteps: number): WorkflowSpec =>
    spec(
      'fanout',
      [setVar('a', 'Local.A', '="1"'), setVar('b', 'Local.B', '="2"'), setVar('c', 'Local.C', '="3"'), setVar('d', 'Local.D', '="4"')],
      [
        ['trigger', 'a'],
        ['trigger', 'b'],
        ['trigger', 'c'],
        ['a', 'd'],
        ['b', 'd'],
        ['c', 'd'],
      ],
      maxSteps,
    )

  test('every parallel node counts against maxSteps (counters sum instead of last-write-wins)', async () => {
    // a, b, c run in one superstep (3 executions) and d runs after: at least 4 node executions in total.
    const tooTight = await rig().rt.startRun({ spec: fanOut(3), actor: 'u' })
    assert.strictEqual(tooTight.status, 'failed')
    assert.ok(tooTight.error?.toLowerCase().includes('node executions'), tooTight.error)

    const enough = await rig().rt.startRun({ spec: fanOut(10), actor: 'u' })
    assert.strictEqual(enough.status, 'completed')
  })

  test('parallel steps get unique ids and distinct, gapless seq numbers', async () => {
    const state = await rig().rt.startRun({ spec: fanOut(10), actor: 'u' })
    const ids = state.steps.map((st) => st.id)
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate step ids: ${ids.join(', ')}`)
    const seqs = state.steps.map((st) => st.seq).sort((x, y) => x - y)
    assert.deepStrictEqual(seqs, seqs.map((_, i) => i + 1))
    for (const nodeId of ['a', 'b', 'c', 'd']) {
      assert.ok(state.steps.some((st) => st.nodeId === nodeId && st.status === 'succeeded'), `${nodeId} ran`)
    }
  })

  test('a goto loop re-entering a node records a fresh step id each time', async () => {
    const looper = spec(
      'loop',
      [setVar('tick', 'Local.T', '="x"'), { id: 'back', kind: 'goto', label: 'Back', data: { targetId: 'tick' } }],
      [
        ['trigger', 'tick'],
        ['tick', 'back'],
      ],
      7,
    )
    const state = await rig().rt.startRun({ spec: looper, actor: 'u' })
    assert.strictEqual(state.status, 'failed') // stops at the step budget
    const tickIds = state.steps.filter((st) => st.nodeId === 'tick').map((st) => st.id)
    assert.ok(tickIds.length > 1)
    assert.strictEqual(new Set(tickIds).size, tickIds.length)
  })
})

suite('Phase 4 (LangGraph) — live streaming', () => {
  test('a node shows as a running step while it is in flight, before its plan exists', async () => {
    const holder = new HoldingDispatcher('plan')
    const { rt } = rig({ dispatcher: holder })
    // Registered BEFORE the run starts so no update can be missed; resolves on the first state that shows the
    // agent as running.
    const sawRunning = new Promise<RunState>((resolve) => {
      rt.onRunUpdate((s) => {
        if (s.steps.some((st) => st.label === 'A' && st.status === 'running')) resolve(s)
      })
    })

    const finished = rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'x' }, actor: 'u' })
    await within(holder.started, 2000, 'the plan dispatch to start')

    // The dispatch is held open, so the plan can't exist yet — but the canvas must already show the node.
    const live = await within(sawRunning, 2000, 'a running step for the in-flight agent')
    const running = live.steps.find((st) => st.label === 'A')!
    assert.strictEqual(running.status, 'running')
    assert.ok(!running.plan, 'no plan while the plan dispatch is still in flight')

    holder.releaseNow()
    const paused = await finished
    assert.strictEqual(paused.status, 'awaiting_approval')
    const agentSteps = paused.steps.filter((st) => st.label === 'A')
    assert.strictEqual(agentSteps.length, 1, 'the provisional step is replaced by the real one, not duplicated')
    assert.ok(agentSteps[0].plan)
    assert.strictEqual(agentSteps[0].id, running.id, 'the provisional step and the real step share an id')
  })

  test('steps arrive in order across the whole run (agent then its gate)', async () => {
    const { rt } = rig()
    const order: string[] = []
    rt.onRunUpdate((s) => {
      for (const st of s.steps) if (st.status !== 'running' && !order.includes(st.id)) order.push(st.id)
    })
    const paused = await rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'x' }, actor: 'u' })
    const done = await approveAll(rt, paused)
    assert.strictEqual(done.status, 'completed')
    const labels = order.map((id) => done.steps.find((st) => st.id === id)!.kind)
    assert.deepStrictEqual(labels, ['agent', 'gate'])
  })
})

suite('Phase 4 (LangGraph) — cancel', () => {
  test('cancel aborts an in-flight node, keeps the run cancelled, and cleans up its stores', async () => {
    const holder = new HoldingDispatcher('plan')
    const r = rig({ dispatcher: holder })
    const ids: string[] = []
    r.rt.onRunUpdate((s) => ids.push(s.runId))

    const finished = r.rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'x' }, actor: 'u' })
    await within(holder.started, 2000, 'the plan dispatch to start')
    const runId = ids[0]

    const cancelled = await r.rt.cancelRun(runId)
    assert.strictEqual(cancelled.status, 'cancelled')
    assert.strictEqual(holder.signalSeen?.aborted, true, 'the dispatcher was told to stop')
    assert.ok(cancelled.steps.every((st) => st.status !== 'running'), 'nothing is left looking alive')

    holder.releaseNow() // the dispatch finishing late must not resurrect the run
    const afterLate = await within(finished, 2000, 'startRun to return after cancel')
    assert.strictEqual(afterLate.status, 'cancelled')
    assert.strictEqual((await r.rt.getRun(runId))?.status, 'cancelled')

    assert.strictEqual(await r.runMeta.get(runId), undefined, 'run metadata deleted')
    assert.strictEqual(await hasThread(r.checkpointer, runId), false, 'checkpoint thread deleted')
  })

  test('a cancelled paused run does not come back after a restart', async () => {
    const r = rig()
    const paused = await r.rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'x' }, actor: 'u' })
    assert.strictEqual(paused.status, 'awaiting_approval')
    await r.rt.cancelRun(paused.runId)

    const restored = await restarted(r).restoreRuns()
    assert.deepStrictEqual(restored, [])
  })

  test('cancelling an already finished run is a no-op', async () => {
    const r = rig()
    const done = await approveAll(r.rt, await r.rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'x' }, actor: 'u' }))
    assert.strictEqual(done.status, 'completed')
    assert.strictEqual((await r.rt.cancelRun(done.runId)).status, 'completed')
  })
})

suite('Phase 4 (LangGraph) — finished runs are cleaned up', () => {
  const oneAgent = (): WorkflowSpec => internalAgentToSpec([agent('A')], { name: 'demo' })

  test('completed run deletes its thread and metadata', async () => {
    const r = rig()
    const done = await approveAll(r.rt, await r.rt.startRun({ spec: oneAgent(), inputs: { task: 'x' }, actor: 'u' }))
    assert.strictEqual(done.status, 'completed')
    assert.strictEqual(await r.runMeta.get(done.runId), undefined)
    assert.strictEqual(await hasThread(r.checkpointer, done.runId), false)
  })

  test('failed run (plan rejected) deletes its thread and metadata', async () => {
    const r = rig()
    const paused = await r.rt.startRun({ spec: oneAgent(), inputs: { task: 'x' }, actor: 'u' })
    const failed = await r.rt.submitApproval(paused.runId, { approve: false, actor: 'a@x' })
    assert.strictEqual(failed.status, 'failed')
    assert.strictEqual(await r.runMeta.get(failed.runId), undefined)
    assert.strictEqual(await hasThread(r.checkpointer, failed.runId), false)
  })

  test('failed run (budget) deletes its thread and metadata', async () => {
    const r = rig()
    const looper = spec('loop', [{ id: 'g', kind: 'goto', label: 'g', data: { targetId: 'g' } }], [['trigger', 'g']], 3)
    const failed = await r.rt.startRun({ spec: looper, actor: 'u' })
    assert.strictEqual(failed.status, 'failed')
    assert.strictEqual(await r.runMeta.get(failed.runId), undefined)
    assert.strictEqual(await hasThread(r.checkpointer, failed.runId), false)
  })

  test('a PAUSED run keeps its thread and metadata (that is what makes restore possible)', async () => {
    const r = rig()
    const paused = await r.rt.startRun({ spec: oneAgent(), inputs: { task: 'x' }, actor: 'u' })
    assert.strictEqual(paused.status, 'awaiting_approval')
    assert.ok(await r.runMeta.get(paused.runId))
    assert.strictEqual(await hasThread(r.checkpointer, paused.runId), true)
  })
})

suite('Phase 4 (LangGraph) — restoring runs after a restart', () => {
  test('a paused run is restored with its plan, can be approved, and then cleans up', async () => {
    const r = rig()
    const paused = await r.rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'x' }, actor: 'rajnish@x' })

    const rt2 = restarted(r)
    const restored = await rt2.restoreRuns()
    assert.strictEqual(restored.length, 1)
    assert.strictEqual(restored[0].runId, paused.runId)
    assert.strictEqual(restored[0].status, 'awaiting_approval')
    assert.strictEqual(restored[0].actor, 'rajnish@x')
    assert.ok(restored[0].pendingApproval?.plan)

    const done = await rt2.submitApproval(paused.runId, { approve: true, actor: 'approver@x' })
    assert.strictEqual(done.status, 'completed')
    assert.deepStrictEqual(await restarted(r).restoreRuns(), [], 'a finished run is not restored again')
  })

  test('a run that died mid-step is restored as failed (not stuck running) and shown only once', async () => {
    const holder = new HoldingDispatcher('plan')
    const r = rig({ dispatcher: holder })
    const finished = r.rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'x' }, actor: 'u' })
    await within(holder.started, 2000, 'the plan dispatch to start')

    // The "old" host never gets to finish; a new one comes up over the same stores.
    const restored = await restarted({ ...r, deps: { ...r.deps, dispatcher: new StubAgentDispatcher() } }).restoreRuns()
    assert.strictEqual(restored.length, 1)
    assert.strictEqual(restored[0].status, 'failed')
    assert.ok(restored[0].error?.includes('interrupted'), restored[0].error)

    assert.deepStrictEqual(await restarted(r).restoreRuns(), [], 'cleaned up after being surfaced once')
    holder.releaseNow()
    await finished
  })

  test('paused runs older than the retention window are discarded, not resurrected', async () => {
    const r = rig()
    const paused = await r.rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'x' }, actor: 'u' })

    const muchLater = paused.startedAt + PAUSED_RUN_RETENTION_MS + 1
    const rt2 = new LangGraphWorkflowRuntime({ ...r.deps, now: () => muchLater })
    assert.deepStrictEqual(await rt2.restoreRuns(), [])
    assert.strictEqual(await r.runMeta.get(paused.runId), undefined)
    assert.strictEqual(await hasThread(r.checkpointer, paused.runId), false)
  })

  test('run ids stay unique across sessions, so a new run cannot collide with a restored one', async () => {
    const r = rig()
    const first = await r.rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'x' }, actor: 'u' })
    // A fresh runtime starts its counter at 0 again — with the same clock tick the id must still differ.
    const rt2 = new LangGraphWorkflowRuntime({ ...r.deps, now: () => first.startedAt + 5_000 })
    const second = await rt2.startRun({ spec: internalAgentToSpec([agent('B')], { name: 'demo' }), inputs: { task: 'y' }, actor: 'u' })
    assert.notStrictEqual(second.runId, first.runId)
    assert.strictEqual((await restarted(r).restoreRuns()).length, 2)
  })

  test('runtimes without a durable store simply have nothing to restore', async () => {
    const { rt } = rig()
    assert.deepStrictEqual(await rt.restoreRuns(), [])
  })
})

suite('Phase 4 (LangGraph) — gate receives the work item and the cancel signal', () => {
  test('the gate is called with the run task as `query` and an AbortSignal', async () => {
    const calls: GateEvaluationInput[] = []
    const recordingGate: GateEvaluator = {
      async evaluate(input): Promise<GateDecision> {
        calls.push(input)
        return { pass: true, perEvaluator: [], reason: 'ok' }
      },
    }
    const { rt } = rig({ gate: recordingGate })
    const paused = await rt.startRun({ spec: internalAgentToSpec([agent('A')], { name: 'demo' }), inputs: { task: 'build a thing' }, actor: 'u' })
    const done = await approveAll(rt, paused)
    assert.strictEqual(done.status, 'completed')
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].query, 'build a thing')
    assert.ok(calls[0].output.includes('processed'))
    assert.ok(calls[0].signal instanceof AbortSignal)
  })
})
