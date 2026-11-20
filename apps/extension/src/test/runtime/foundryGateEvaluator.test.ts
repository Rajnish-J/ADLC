// Phase 3 -> 4 — the real in-run gate. Offline: a fake EvalRunner stands in for Foundry, so this proves the
// wiring and the decision logic (what is asked of the evaluators, how scores become block/pass, what happens
// when evaluation can't run) — NOT the Azure call itself, which needs a live project and judge deployment.
//
// Pure (no `vscode`): runs in the extension test host and under plain mocha
//   npm run compile-tests && npx mocha --ui tdd out/test/runtime/foundryGateEvaluator.test.js

import * as assert from 'assert'
import type { EvalRunner, RunOptions } from '../../eval/evalClient'
import type { EvalDataset, EvalRunResult, EvalScore, GatePolicy } from '../../eval/types'
import { AutoGateEvaluator, FoundryGateEvaluator, type GateResultEvent } from '../../runtime/gate/foundryGateEvaluator'
import type { GateEvaluationInput, GateEvaluator } from '../../runtime/port'
import type { GateDecision } from '../../eval/types'

const COHERENCE = 'builtin.coherence'
const VIOLENCE = 'builtin.violence'
const TOOL_CALLS = 'builtin.tool_call_accuracy'

function policy(overrides: Partial<GatePolicy> = {}): GatePolicy {
  return {
    judgeDeployment: 'judge-model',
    sampling: { strategy: 'none' },
    failClosedOnError: true,
    steps: {
      review: { evaluators: [COHERENCE], required: [COHERENCE], thresholds: { [COHERENCE]: 3 } },
      release: { evaluators: [VIOLENCE], required: [VIOLENCE], thresholds: { [VIOLENCE]: 3 } },
      implement: {
        evaluators: [COHERENCE, TOOL_CALLS],
        required: [COHERENCE, TOOL_CALLS],
        thresholds: { [COHERENCE]: 3, [TOOL_CALLS]: 3 },
      },
      design: { evaluators: [], required: [], thresholds: {} },
    },
    ...overrides,
  }
}

const score = (evaluator: string, value: number | null, extra: Partial<EvalScore> = {}): EvalScore => ({
  evaluator,
  score: value,
  passed: 0,
  failed: 0,
  errored: 0,
  ...extra,
})

class FakeRunner implements EvalRunner {
  datasets: EvalDataset[] = []
  options: RunOptions[] = []
  constructor(private readonly respond: (d: EvalDataset) => EvalScore[] | Error) {}

  async run(dataset: EvalDataset, opts: RunOptions): Promise<EvalRunResult> {
    this.datasets.push(dataset)
    this.options.push(opts)
    const out = this.respond(dataset)
    if (out instanceof Error) throw out
    return { evalId: 'e1', runId: 'r1', status: 'completed', scores: out, usage: { tokensIn: 1, tokensOut: 1 } }
  }
}

function gate(
  runner: EvalRunner,
  opts: { policy?: GatePolicy; endpoint?: string | undefined; onResult?: (e: GateResultEvent) => void | Promise<void> } = {},
): FoundryGateEvaluator {
  return new FoundryGateEvaluator({
    runner,
    resolvePolicy: async () => opts.policy ?? policy(),
    runConfig: () => ({ transport: 'fetch', pollIntervalMs: 10, pollTimeoutMs: 1000 }),
    resolveProjectEndpoint: async () => ('endpoint' in opts ? opts.endpoint : 'https://acct.services.ai.azure.com/api/projects/p'),
    onResult: opts.onResult,
    now: () => new Date('2026-10-30T00:00:00.000Z'),
  })
}

const input = (over: Partial<GateEvaluationInput> = {}): GateEvaluationInput => ({
  sdlcStep: 'review',
  output: 'the agent output',
  query: 'build the login page',
  ...over,
})

suite('FoundryGateEvaluator — decisions', () => {
  test('passes when the required evaluator meets its threshold, and asks Foundry about this step', async () => {
    const runner = new FakeRunner(() => [score(COHERENCE, 4)])
    const events: GateResultEvent[] = []
    const decision = await gate(runner, { onResult: (e) => void events.push(e) }).evaluate(input())

    assert.strictEqual(decision.pass, true)
    assert.strictEqual(runner.datasets.length, 1)
    assert.deepStrictEqual(runner.datasets[0].evaluators, [COHERENCE])
    assert.strictEqual(runner.datasets[0].data.length, 1)
    assert.strictEqual(runner.datasets[0].data[0].query, 'build the login page')
    assert.strictEqual(runner.datasets[0].data[0].response, 'the agent output')
    assert.strictEqual(runner.options[0].projectEndpoint, 'https://acct.services.ai.azure.com/api/projects/p')
    assert.strictEqual(runner.options[0].transport, 'fetch')
    assert.strictEqual(events.length, 1, 'onResult fires once per real evaluation')
    assert.strictEqual(events[0].step, 'review')
    assert.strictEqual(events[0].decision, decision)
  })

  test('blocks when a required evaluator scores below its threshold', async () => {
    const decision = await gate(new FakeRunner(() => [score(COHERENCE, 2)])).evaluate(input())
    assert.strictEqual(decision.pass, false)
    assert.ok(decision.reason.includes(COHERENCE), decision.reason)
  })

  test('safety severity is LOWER-is-better: a severe score blocks and a mild one passes', async () => {
    // Regression for Govern & Evaluate, which omitted LOWER_IS_BETTER: a severity of 6 against a threshold of 3
    // was judged "6 >= 3" and PASSED. 0-7 severity: higher means worse.
    const severe = await gate(new FakeRunner(() => [score(VIOLENCE, 6)])).evaluate(input({ sdlcStep: 'release' }))
    assert.strictEqual(severe.pass, false, severe.reason)
    const mild = await gate(new FakeRunner(() => [score(VIOLENCE, 1)])).evaluate(input({ sdlcStep: 'release' }))
    assert.strictEqual(mild.pass, true, mild.reason)
  })

  test('a step with no evaluators configured passes without calling Foundry', async () => {
    const runner = new FakeRunner(() => [])
    const decision = await gate(runner).evaluate(input({ sdlcStep: 'design' }))
    assert.strictEqual(decision.pass, true)
    assert.strictEqual(runner.datasets.length, 0)
  })

  test('uses a placeholder query when the run had no task, so query-based evaluators still get a row', async () => {
    const runner = new FakeRunner(() => [score(COHERENCE, 4)])
    await gate(runner).evaluate(input({ query: '   ' }))
    assert.ok(String(runner.datasets[0].data[0].query).length > 0)
  })

  test('cancellation is forwarded to the evaluation poller', async () => {
    const runner = new FakeRunner(() => [score(COHERENCE, 4)])
    const ac = new AbortController()
    await gate(runner).evaluate(input({ signal: ac.signal }))
    assert.strictEqual(runner.options[0].isCancelled?.(), false)
    ac.abort()
    assert.strictEqual(runner.options[0].isCancelled?.(), true)
  })
})

suite('FoundryGateEvaluator — when evaluation cannot run', () => {
  test('a runner error blocks when fail-closed and passes when fail-open', async () => {
    const boom = new FakeRunner(() => new Error('boom'))
    const closed = await gate(boom).evaluate(input())
    assert.strictEqual(closed.pass, false)
    assert.ok(closed.reason.includes('boom') && closed.reason.includes('fail-closed'), closed.reason)

    const open = await gate(boom, { policy: policy({ failClosedOnError: false }) }).evaluate(input())
    assert.strictEqual(open.pass, true)
    assert.ok(open.reason.includes('fail-open'), open.reason)
  })

  test('no Foundry project: blocks when fail-closed, passes when fail-open, never calls the runner', async () => {
    const runner = new FakeRunner(() => [score(COHERENCE, 5)])
    const closed = await gate(runner, { endpoint: undefined }).evaluate(input())
    assert.strictEqual(closed.pass, false)
    assert.ok(closed.reason.includes('no Foundry project'), closed.reason)
    const open = await gate(runner, { endpoint: undefined, policy: policy({ failClosedOnError: false }) }).evaluate(input())
    assert.strictEqual(open.pass, true)
    assert.strictEqual(runner.datasets.length, 0)
  })

  test('an evaluator that returns no result fails closed', async () => {
    const decision = await gate(new FakeRunner(() => [])).evaluate(input())
    assert.strictEqual(decision.pass, false)
  })

  test('a throwing onResult hook never changes the decision', async () => {
    const decision = await gate(new FakeRunner(() => [score(COHERENCE, 5)]), {
      onResult: () => {
        throw new Error('audit store offline')
      },
    }).evaluate(input())
    assert.strictEqual(decision.pass, true)
  })
})

suite('FoundryGateEvaluator — evaluators an in-run gate cannot run', () => {
  test('tool_call_accuracy is not sent, cannot block the step, and the skip is recorded in the decision', async () => {
    // The default implement/review steps list tool_call_accuracy as REQUIRED, but an in-run gate has no tool-call
    // trace — sending it would error on every row and a fail-closed policy would block every implement step.
    const runner = new FakeRunner((d) => d.evaluators.map((e) => score(e, 4)))
    const decision = await gate(runner).evaluate(input({ sdlcStep: 'implement' }))

    assert.deepStrictEqual(runner.datasets[0].evaluators, [COHERENCE], 'only evaluators that can run are sent')
    assert.strictEqual(decision.pass, true)
    const skipped = decision.perEvaluator.find((d) => d.evaluator === TOOL_CALLS)
    assert.ok(skipped, 'the skipped evaluator is listed, not silently dropped')
    assert.strictEqual(skipped?.required, true)
    assert.ok(skipped?.reason.startsWith('skipped'), skipped?.reason)
    assert.ok(decision.reason.includes(`skipped: ${TOOL_CALLS}`), decision.reason)
  })

  test('a step whose only evaluators cannot run passes with an explicit reason and no Foundry call', async () => {
    const onlyTools = policy({
      steps: { implement: { evaluators: [TOOL_CALLS], required: [TOOL_CALLS], thresholds: { [TOOL_CALLS]: 3 } } },
    })
    const runner = new FakeRunner(() => [])
    const decision = await gate(runner, { policy: onlyTools }).evaluate(input({ sdlcStep: 'implement' }))
    assert.strictEqual(decision.pass, true)
    assert.strictEqual(runner.datasets.length, 0)
    assert.ok(decision.reason.includes('skipped'), decision.reason)
  })

  test('other evaluators still block even when tool_call_accuracy is skipped', async () => {
    const runner = new FakeRunner((d) => d.evaluators.map((e) => score(e, 1)))
    const decision = await gate(runner).evaluate(input({ sdlcStep: 'implement' }))
    assert.strictEqual(decision.pass, false)
  })
})

suite('AutoGateEvaluator', () => {
  const decisionOf = (reason: string): GateDecision => ({ pass: true, perEvaluator: [], reason })
  const named = (reason: string): GateEvaluator & { calls: number } => ({
    calls: 0,
    async evaluate() {
      this.calls += 1
      return decisionOf(reason)
    },
  })

  test('uses Foundry when it is available', async () => {
    const foundry = named('from foundry')
    const stub = named('from stub')
    const warnings: string[] = []
    const auto = new AutoGateEvaluator(foundry, stub, async () => true, (m) => void warnings.push(m))
    const d = await auto.evaluate(input())
    assert.strictEqual(d.reason, 'from foundry')
    assert.strictEqual(stub.calls, 0)
    assert.deepStrictEqual(warnings, [])
  })

  test('falls back to the stub when Foundry is not configured, labels the verdict, and warns exactly once', async () => {
    const foundry = named('from foundry')
    const stub = named('from stub')
    const warnings: string[] = []
    const auto = new AutoGateEvaluator(foundry, stub, async () => false, (m) => void warnings.push(m))

    const first = await auto.evaluate(input())
    const second = await auto.evaluate(input())
    assert.ok(first.reason.startsWith('[offline stub gate'), first.reason)
    assert.ok(first.reason.endsWith('from stub'))
    assert.ok(second.reason.startsWith('[offline stub gate'))
    assert.strictEqual(foundry.calls, 0)
    assert.strictEqual(stub.calls, 2)
    assert.strictEqual(warnings.length, 1, 'the fallback warning is shown once, not per gate')
  })

  test('re-checks availability on every call, so signing in mid-session switches to Foundry', async () => {
    const foundry = named('from foundry')
    const stub = named('from stub')
    let available = false
    const auto = new AutoGateEvaluator(foundry, stub, async () => available, () => {})
    assert.ok((await auto.evaluate(input())).reason.includes('from stub'))
    available = true
    assert.strictEqual((await auto.evaluate(input())).reason, 'from foundry')
  })
})
