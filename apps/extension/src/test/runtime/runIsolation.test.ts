// Per-run isolation and budget fixes: paused time no longer counts against a run's time budget, dispatches
// carry their run/node/step ids (so the dispatcher can keep per-run context), live activity is attributed to
// the right run, and the tool gate never hands write tools to an unresolved agent or a planning turn.
//
// Pure (no `vscode`): runs under the VS Code test host AND under plain mocha.

import * as assert from 'assert'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import type { InternalAgent } from '../../discovery/agentModel'
import { internalAgentToSpec } from '../../runtime/compile/internalAgentToSpec'
import { BudgetExceededError, GuardState } from '../../runtime/guards'
import { InMemoryRunMetaPort, LangGraphWorkflowRuntime } from '../../runtime/langgraph/langGraphRuntime'
import { MockWorkflowRuntime } from '../../runtime/mock/mockRuntime'
import { StubAgentDispatcher, StubGateEvaluator } from '../../runtime/mock/stubs'
import { resolveDispatchTools } from '../../runtime/dispatch/toolGating'
import type {
  AgentDispatcher,
  AgentDispatchInput,
  AgentDispatchResult,
  FragmentSource,
  RunState,
  WorkflowRuntime,
} from '../../runtime/port'
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

/** A two-agent spec with a short (1s) time budget. */
function shortBudgetSpec(): WorkflowSpec {
  const spec = internalAgentToSpec([agent('Designer'), agent('Implementer')], { name: 'budget' })
  return { ...spec, budget: { maxSteps: 50, timeoutMs: 1_000 } }
}

/** A controllable clock: advances 1ms per read, plus explicit jumps. */
function clock(): { now: () => number; jump: (ms: number) => void } {
  let t = 1_000
  return { now: () => (t += 1), jump: (ms) => (t += ms) }
}

/** Approve every pending approval, letting `beforeEach` simulate the human taking their time. */
async function approveAll(rt: WorkflowRuntime, state: RunState, beforeEach: () => void): Promise<RunState> {
  let s = state
  while (s.status === 'awaiting_approval') {
    beforeEach()
    s = await rt.submitApproval(s.runId, { approve: true, actor: 'approver@x' })
  }
  return s
}

/** Records every dispatch input; optionally streams fragments through observers like LmAgentDispatcher does. */
class RecordingDispatcher implements AgentDispatcher {
  readonly inputs: AgentDispatchInput[] = []
  private readonly observers = new Set<(agentName: string, fragment: string, source: FragmentSource) => void>()
  /** Fragments to emit during each dispatch, as [source runId override | undefined, text]. */
  fragments: Array<[string | undefined, string]> = []

  observeFragments(fn: (agentName: string, fragment: string, source: FragmentSource) => void): { dispose(): void } {
    this.observers.add(fn)
    return { dispose: () => this.observers.delete(fn) }
  }

  async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    this.inputs.push(input)
    // Like a real model, start streaming only after a beat — by then the runtime has shown the step as running.
    if (this.fragments.length > 0) await new Promise((r) => setTimeout(r, 10))
    for (const [runIdOverride, text] of this.fragments) {
      const source: FragmentSource = { runId: runIdOverride ?? input.runId, stepId: input.stepId }
      for (const fn of this.observers) fn(input.agentName, text, source)
    }
    return { response: `${input.agentName} ${input.phase} done`, tokensIn: 1, tokensOut: 1 }
  }
}

suite('Run isolation & budget', () => {
  suite('GuardState time budget', () => {
    test('time spent paused is excluded from the time limit', () => {
      const guard = new GuardState({ maxSteps: 10, timeoutMs: 1_000 }, 0)
      guard.tick(500)
      guard.addPausedMs(60 * 60 * 1000) // an hour awaiting approval
      assert.doesNotThrow(() => guard.tick(60 * 60 * 1000 + 900))
    })

    test('active time over the limit still trips the budget', () => {
      const guard = new GuardState({ maxSteps: 10, timeoutMs: 1_000 }, 0, { pausedMs: 5_000 })
      assert.throws(() => guard.tick(7_000), (e: unknown) => e instanceof BudgetExceededError && e.cause === 'timeout')
    })
  })

  suite('MockWorkflowRuntime', () => {
    test('a run paused on plan approval longer than its time budget still completes', async () => {
      const c = clock()
      const rt = new MockWorkflowRuntime({ dispatcher: new StubAgentDispatcher(), gate: new StubGateEvaluator(), now: c.now })
      const started = await rt.startRun({ spec: shortBudgetSpec(), inputs: { task: 't' }, actor: 'a' })
      assert.strictEqual(started.status, 'awaiting_approval')
      const done = await approveAll(rt, started, () => c.jump(10 * 60 * 1000)) // 10 minutes per approval
      assert.strictEqual(done.status, 'completed', done.error)
    })

    test('honours a caller-chosen run id and passes run/node/step ids to the dispatcher', async () => {
      const dispatcher = new RecordingDispatcher()
      const rt = new MockWorkflowRuntime({ dispatcher, gate: new StubGateEvaluator() })
      const started = await rt.startRun({ spec: shortBudgetSpec(), inputs: { task: 't' }, actor: 'a', runId: 'run-fixed' })
      assert.strictEqual(started.runId, 'run-fixed')
      await approveAll(rt, started, () => undefined)
      assert.ok(dispatcher.inputs.length >= 4)
      for (const input of dispatcher.inputs) {
        assert.strictEqual(input.runId, 'run-fixed')
        assert.ok(input.nodeId, 'nodeId set')
        assert.ok(input.stepId, 'stepId set')
      }
      await assert.rejects(rt.startRun({ spec: shortBudgetSpec(), actor: 'a', runId: 'run-fixed' }), /already in use/)
    })
  })

  suite('LangGraphWorkflowRuntime', () => {
    function langGraph(dispatcher: AgentDispatcher, now?: () => number): LangGraphWorkflowRuntime {
      return new LangGraphWorkflowRuntime({
        dispatcher,
        gate: new StubGateEvaluator(),
        checkpointer: new MemorySaver(),
        runMeta: new InMemoryRunMetaPort(),
        now,
      })
    }

    test('a run paused on plan approval longer than its time budget still completes', async () => {
      const c = clock()
      const rt = langGraph(new StubAgentDispatcher(), c.now)
      const started = await rt.startRun({ spec: shortBudgetSpec(), inputs: { task: 't' }, actor: 'a' })
      assert.strictEqual(started.status, 'awaiting_approval')
      const done = await approveAll(rt, started, () => c.jump(10 * 60 * 1000))
      assert.strictEqual(done.status, 'completed', done.error)
    })

    test('honours a caller-chosen run id and passes run/node/step ids to the dispatcher', async () => {
      const dispatcher = new RecordingDispatcher()
      const rt = langGraph(dispatcher)
      const started = await rt.startRun({ spec: shortBudgetSpec(), inputs: { task: 't' }, actor: 'a', runId: 'lg-fixed' })
      assert.strictEqual(started.runId, 'lg-fixed')
      await approveAll(rt, started, () => undefined)
      assert.ok(dispatcher.inputs.length >= 4)
      for (const input of dispatcher.inputs) {
        assert.strictEqual(input.runId, 'lg-fixed')
        assert.ok(input.nodeId, 'nodeId set')
        assert.ok(input.stepId?.startsWith('lg-fixed-'), `stepId ${input.stepId} belongs to the run`)
      }
    })

    test("live activity ignores fragments attributed to another run", async () => {
      const dispatcher = new RecordingDispatcher()
      dispatcher.fragments = [
        ['some-other-run', 'FOREIGN '],
        [undefined, 'mine'],
      ]
      const rt = langGraph(dispatcher)
      const thoughts: string[] = []
      rt.onRunUpdate((s) => {
        for (const step of s.steps) if (step.activity?.thought) thoughts.push(step.activity.thought)
      })
      await rt.startRun({ spec: shortBudgetSpec(), inputs: { task: 't' }, actor: 'a', runId: 'lg-mine' })
      assert.ok(thoughts.length > 0, 'activity was streamed')
      for (const t of thoughts) assert.ok(!t.includes('FOREIGN'), `foreign fragment leaked into activity: ${t}`)
    })
  })

  suite('resolveDispatchTools', () => {
    const base = { allowAdoWrites: true, allowPRs: true }

    test('an unresolved agent gets read-only file tools and no write tools', () => {
      const perms = resolveDispatchTools({ ...base, agentTools: undefined, resolved: false, phase: 'execute' })
      assert.deepStrictEqual([...(perms.file as Set<string>)].sort(), ['list_dir', 'read_file', 'search_text'])
      assert.strictEqual(perms.ado.write.size, 0)
      assert.strictEqual(perms.git.write.size, 0)
    })

    test('a resolved agent that declares no tools keeps every file tool when executing', () => {
      const perms = resolveDispatchTools({ ...base, agentTools: undefined, resolved: true, phase: 'execute' })
      assert.strictEqual(perms.file, 'all')
    })

    test('a planning turn is read-only, whatever the agent declares', () => {
      const perms = resolveDispatchTools({
        ...base,
        agentTools: ['write', 'edit', 'git', 'boards'],
        resolved: true,
        phase: 'plan',
      })
      assert.deepStrictEqual([...(perms.file as Set<string>)].sort(), [])
      assert.strictEqual(perms.ado.write.size, 0)
      assert.strictEqual(perms.git.write.size, 0)

      const unspecified = resolveDispatchTools({ ...base, agentTools: undefined, resolved: true, phase: 'plan' })
      assert.deepStrictEqual([...(unspecified.file as Set<string>)].sort(), ['list_dir', 'read_file', 'search_text'])
    })

    test('the execute turn grants declared write tools only when the kill-switches allow', () => {
      const declared = ['read', 'edit', 'git', 'boards']
      const on = resolveDispatchTools({ ...base, agentTools: declared, resolved: true, phase: 'execute' })
      assert.ok((on.file as Set<string>).has('replace_in_file'))
      assert.ok(on.git.write.has('git_commit_and_push'))
      assert.ok(on.ado.write.has('update_work_item'))

      const off = resolveDispatchTools({ agentTools: declared, resolved: true, phase: 'execute', allowAdoWrites: false, allowPRs: false })
      assert.strictEqual(off.git.write.size, 0)
      assert.strictEqual(off.ado.write.size, 0)
    })
  })
})
