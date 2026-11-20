// Orchestrator-driven runs: the platform drives the workflow and hands each agent step to a harness here. The
// remote step source (the SDLC tools proxied to the platform), the tools passing `outputs` through, the
// per-harness protocol and prompt, file checkpoints for harnesses without the tools, and the new API calls.
//
// Pure (no `vscode`): runs under the VS Code test host AND under plain mocha.

import * as assert from 'assert'
import type { NextStep, StepAssignment } from '@sdlc/contracts'
import { StepChannel } from '../../runtime/dispatch/external/stepChannel'
import { launchPrompt, nextFile, orchestratorMarkdown, promptSummary, protocolFile } from '../../platform/engines/orchestratorPrompt'
import { PlatformClient, PlatformError } from '../../platform/platformClient'
import { parseSseFrames } from '../../platform/platformEvents'
import { CheckpointPump, checkpointText, parseDone } from '../../platform/session/checkpointPump'
import { RemoteStepSource, type StepClient } from '../../platform/session/remoteSteps'
import { buildSdlcTools, stepOutputs } from '../../platform/session/sdlcTools'
import type { SessionFiles } from '../../platform/session/sessionFiles'
import type { StepCompleteOptions, StepEvent, StepSource } from '../../platform/session/stepSource'

const assignment = (over: Partial<StepAssignment> = {}): StepAssignment => ({
  action: 'plan',
  stepId: 's1',
  nodeId: 'n1',
  agentId: 'planner',
  agentName: 'Planner',
  instructions: 'Plan the refund endpoint',
  skills: [{ slug: 'api-design', name: 'API design' }],
  ...over,
})

interface Call {
  method: 'nextStep' | 'submitPlan' | 'completeStep'
  args: unknown[]
}

/** A stub of the platform client's step calls: answers polls from `answers` (the last one repeats). */
function stubClient(answers: NextStep[], calls: Call[], fail?: Partial<Record<Call['method'], Error>>): StepClient {
  let i = 0
  return {
    nextStep: async (...args) => {
      calls.push({ method: 'nextStep', args })
      if (fail?.nextStep) throw fail.nextStep
      return answers[Math.min(i++, answers.length - 1)]
    },
    submitPlan: async (...args) => {
      calls.push({ method: 'submitPlan', args })
      if (fail?.submitPlan) throw fail.submitPlan
      return { ok: true as const, stepId: args[2] }
    },
    completeStep: async (...args) => {
      calls.push({ method: 'completeStep', args })
      if (fail?.completeStep) throw fail.completeStep
      return { ok: true as const, stepId: args[2] }
    },
  }
}

suite('Orchestrated runs — remote step source', () => {
  test('a poll asks for this harness’s step and records when it polled', async () => {
    const calls: Call[] = []
    let now = 1_000
    const src = new RemoteStepSource({
      client: stubClient([assignment()], calls),
      projectKey: 'PAY',
      harness: 'claude-code',
      clientId: 'window-1234',
      now: () => now,
    })
    assert.strictEqual(src.lastPollAt, undefined)
    assert.strictEqual(src.isActive(), false)
    const next = await src.poll('r1', 30_000)
    assert.strictEqual(next.action, 'plan')
    assert.deepStrictEqual(calls[0], { method: 'nextStep', args: ['PAY', 'r1', { harness: 'claude-code', clientId: 'window-1234', wait: 30 }] })
    assert.strictEqual(src.lastPollAt, 1_000)
    now = 15_000
    assert.strictEqual(src.isActive(20_000), true)
    now = 30_000
    assert.strictEqual(src.isActive(20_000), false, 'not polled for more than 20 s')
    await src.poll('r1', 120_000)
    assert.strictEqual((calls[1].args[2] as { wait: number }).wait, 50, 'the wait is capped at the platform’s 50 s')
    assert.strictEqual(src.lastPollAt, 30_000)
  })

  test('an assignment is enriched and reported as delivered once per step and phase', async () => {
    const events: StepEvent[] = []
    const src = new RemoteStepSource({
      client: stubClient([assignment(), assignment(), assignment({ action: 'execute', approvedPlan: 'Add POST /refunds' })], []),
      projectKey: 'PAY',
      harness: 'claude-code',
      enrich: (a) => ({ ...a, skills: a.skills.map((s) => ({ ...s, path: `.claude/skills/sdlc-${s.slug}/SKILL.md` })) }),
    })
    src.onEvent((e) => events.push(e))
    const first = await src.poll('r1')
    assert.ok(first.action === 'plan' && first.skills[0].path === '.claude/skills/sdlc-api-design/SKILL.md')
    await src.poll('r1')
    const exec = await src.poll('r1')
    assert.strictEqual(exec.action, 'execute')
    assert.deepStrictEqual(
      events.map((e) => (e.type === 'delivered' ? `${e.type}:${e.stepId}:${e.phase}:${e.harness}` : e.type)),
      ['delivered:s1:plan:claude-code', 'delivered:s1:execute:claude-code'],
    )
  })

  test('handoff, done and stopped end the harness’s turn', async () => {
    const results: string[] = []
    const src = new RemoteStepSource({
      client: stubClient(
        [
          { action: 'waiting', reason: 'approval', retryAfterSec: 5, message: 'A human is reviewing your plan.' },
          { action: 'handoff', harness: 'copilot', message: 'GitHub Copilot has the next step.' },
          { action: 'done' },
        ],
        [],
      ),
      projectKey: 'PAY',
      harness: 'claude-code',
    })
    src.onResult((_runId, next) => results.push(next.action))
    assert.strictEqual((await src.poll('r1')).action, 'waiting')
    assert.strictEqual(src.idle, false)
    const handoff = await src.poll('r1')
    assert.ok(handoff.action === 'handoff' && handoff.harness === 'copilot')
    assert.strictEqual(src.idle, true)
    assert.strictEqual((await src.poll('r1')).action, 'done')
    assert.strictEqual(src.idle, true)
    assert.deepStrictEqual(results, ['waiting', 'handoff', 'done'])
  })

  test('polling is visible while a long-poll is in flight', async () => {
    let release: (n: NextStep) => void = () => {}
    const client: StepClient = {
      ...stubClient([], []),
      nextStep: () => new Promise<NextStep>((resolve) => (release = resolve)),
    }
    let now = 0
    const src = new RemoteStepSource({ client, projectKey: 'PAY', harness: 'copilot', now: () => now })
    const p = src.poll('r1', 25_000)
    now = 60_000
    assert.strictEqual(src.polling, true)
    assert.strictEqual(src.isActive(20_000), true, 'a poll in flight counts as active however long ago it started')
    release({ action: 'done' })
    await p
    assert.strictEqual(src.polling, false)
    assert.strictEqual(src.lastPollAt, 60_000, 'the end of the poll is recorded too')
  })

  test('submitPlan and complete call the step endpoints, then report the activity', async () => {
    const calls: Call[] = []
    const events: StepEvent[] = []
    const src = new RemoteStepSource({ client: () => stubClient([], calls), projectKey: 'PAY', harness: 'copilot' })
    src.onEvent((e) => events.push(e))
    await src.submitPlan('r1', 's1', 'Add POST /refunds')
    await src.complete('r1', 's1', 'Added the endpoint', { skillsUsed: ['api-design', 'api-design'], outputs: { 'Local.TestsPassed': true } })
    await src.complete('r1', 's2', 'Reviewed')
    assert.deepStrictEqual(calls, [
      { method: 'submitPlan', args: ['PAY', 'r1', 's1', { plan: 'Add POST /refunds' }] },
      { method: 'completeStep', args: ['PAY', 'r1', 's1', { summary: 'Added the endpoint', skillsUsed: ['api-design'], outputs: { 'Local.TestsPassed': true } }] },
      { method: 'completeStep', args: ['PAY', 'r1', 's2', { summary: 'Reviewed', skillsUsed: [] }] },
    ])
    assert.deepStrictEqual(events, [
      { type: 'plan.submitted', runId: 'r1', stepId: 's1', plan: 'Add POST /refunds' },
      { type: 'step.completed', runId: 'r1', stepId: 's1', summary: 'Added the endpoint', skillsUsed: ['api-design'] },
      { type: 'step.completed', runId: 'r1', stepId: 's2', summary: 'Reviewed', skillsUsed: [] },
    ])
  })

  test('a refused submission reports nothing and reaches the harness as an error', async () => {
    const events: StepEvent[] = []
    const src = new RemoteStepSource({
      client: stubClient([], [], { submitPlan: new PlatformError('Step s1 is not waiting for a plan.', 409) }),
      projectKey: 'PAY',
      harness: 'copilot',
    })
    src.onEvent((e) => events.push(e))
    await assert.rejects(src.submitPlan('r1', 's1', 'again'), /not waiting for a plan/)
    assert.deepStrictEqual(events, [])
  })

  test('without a platform connection the tools say so', async () => {
    const src = new RemoteStepSource({ client: () => undefined, projectKey: 'PAY', harness: 'copilot' })
    await assert.rejects(src.poll('r1'), /Not connected/)
    assert.strictEqual(src.lastPollAt, undefined)
  })
})

suite('Orchestrated runs — SDLC tools', () => {
  function recordingSource(): StepSource & { calls: Array<[string, ...unknown[]]> } {
    const calls: Array<[string, ...unknown[]]> = []
    return {
      calls,
      poll: async (runId, waitMs) => {
        calls.push(['poll', runId, waitMs])
        return { action: 'handoff', harness: 'copilot', message: 'GitHub Copilot has the next step.' }
      },
      submitPlan: async (runId, stepId, plan) => {
        calls.push(['submitPlan', runId, stepId, plan])
      },
      complete: async (runId, stepId, summary, opts?: StepCompleteOptions) => {
        calls.push(['complete', runId, stepId, summary, opts])
      },
    }
  }

  const tools = (steps: StepSource) =>
    buildSdlcTools({
      runId: 'r1',
      projectKey: 'PAY',
      storyNumber: 2,
      sessionDir: '.sdlc/sessions/PAY-2',
      steps,
      client: () => undefined,
      files: {} as SessionFiles,
      activity: () => undefined,
      currentStep: () => undefined,
    })
  const tool = (steps: StepSource, name: string) => {
    const t = tools(steps).find((x) => x.name === name)
    assert.ok(t, name)
    return t
  }

  test('tool names and their required params are unchanged; complete takes optional outputs', () => {
    const list = tools(recordingSource())
    assert.deepStrictEqual(
      list.map((t) => t.name),
      ['sdlc_next_step', 'sdlc_submit_plan', 'sdlc_complete_step', 'sdlc_get_story', 'sdlc_get_memory', 'sdlc_add_memory'],
    )
    const complete = list.find((t) => t.name === 'sdlc_complete_step')!.inputSchema as { properties: Record<string, unknown>; required: string[] }
    assert.deepStrictEqual(complete.required, ['stepId', 'summary'])
    assert.ok('outputs' in complete.properties && 'skillsUsed' in complete.properties)
  })

  test('sdlc_complete_step passes outputs through to the step source', async () => {
    const src = recordingSource()
    const res = await tool(src, 'sdlc_complete_step').call({
      stepId: 's1',
      summary: 'Ran the tests',
      skillsUsed: ['testing', 42],
      outputs: { 'Local.TestsPassed': true, 'Local.Coverage': 81 },
    })
    assert.deepStrictEqual(res, { ok: true, next: 'Call sdlc_next_step for the next step.' })
    assert.deepStrictEqual(src.calls, [
      ['complete', 'r1', 's1', 'Ran the tests', { skillsUsed: ['testing'], outputs: { 'Local.TestsPassed': true, 'Local.Coverage': 81 } }],
    ])
  })

  test('no outputs, empty outputs and bad outputs', async () => {
    const src = recordingSource()
    await tool(src, 'sdlc_complete_step').call({ stepId: 's1', summary: 'Done' })
    await tool(src, 'sdlc_complete_step').call({ stepId: 's2', summary: 'Done', outputs: {} })
    assert.deepStrictEqual(src.calls.map((c) => c[4]), [{ skillsUsed: [] }, { skillsUsed: [] }])
    await assert.rejects(tool(src, 'sdlc_complete_step').call({ stepId: 's3', summary: 'Done', outputs: ['x'] }), /must be an object/)
    assert.throws(() => stepOutputs({ big: 'x'.repeat(30_000) }), /too large/)
    assert.strictEqual(src.calls.length, 2, 'a bad outputs value never reaches the platform')
  })

  test('next step and plan go to the step source (and a refusal surfaces as a tool error)', async () => {
    const src = recordingSource()
    const next = (await tool(src, 'sdlc_next_step').call({ waitSeconds: 10 })) as NextStep
    assert.strictEqual(next.action, 'handoff')
    await tool(src, 'sdlc_submit_plan').call({ stepId: 's1', plan: 'Add POST /refunds' })
    assert.deepStrictEqual(src.calls, [
      ['poll', 'r1', 10_000],
      ['submitPlan', 'r1', 's1', 'Add POST /refunds'],
    ])
    const refusing: StepSource = { ...src, submitPlan: async () => Promise.reject(new Error('Step s1 is not waiting for a plan.')) }
    await assert.rejects(tool(refusing, 'sdlc_submit_plan').call({ stepId: 's1', plan: 'x' }), /not waiting for a plan/)
  })

  test('the local step channel is a step source too, and outputs become run variables', async () => {
    const ch = new StepChannel()
    const exec = ch.enqueue({ runId: 'r1', nodeId: 'n1', stepId: 's1', agentId: 'dev', agentName: 'Developer', prompt: 'Build it', phase: 'execute' })
    await tool(ch, 'sdlc_complete_step').call({ stepId: 's1', summary: 'Built', outputs: { 'Local.TestsPassed': false } })
    assert.deepStrictEqual((await exec).structured, { 'Local.TestsPassed': false })
  })
})

suite('Orchestrated runs — protocol and prompt', () => {
  const input = {
    runId: 'r1',
    storyKey: 'PAY-2',
    storyTitle: 'Refunds',
    workflowName: 'Story delivery',
    steps: [
      { label: 'Plan', agentName: 'Planner', skills: [], harness: 'claude-code' },
      { label: 'Implement', agentName: 'Developer', skills: ['api-design'], harness: 'copilot' },
    ],
    sessionDir: '.sdlc/sessions/PAY-2',
    tier: 'full' as const,
  }

  test('runs the extension drives keep their prompt and protocol file', () => {
    assert.strictEqual(
      launchPrompt(input),
      '[sdlc:run=r1] Run the Story delivery workflow on PAY-2. Follow .sdlc/sessions/PAY-2/ORCHESTRATOR.md exactly: call the sdlc_next_step tool to get your first step.',
    )
    assert.strictEqual(protocolFile(input), '.sdlc/sessions/PAY-2/ORCHESTRATOR.md')
    assert.ok(!orchestratorMarkdown(input).includes('handoff'))
  })

  test('each harness of an orchestrator-driven run gets its own prompt, with the hand-off rule', () => {
    const mine = { ...input, harness: { id: 'claude-code', label: 'Claude Code' } }
    const prompt = launchPrompt(mine)
    assert.ok(prompt.startsWith('[sdlc:run=r1] You are working the Claude Code steps of this run'))
    assert.ok(prompt.includes('.sdlc/sessions/PAY-2/ORCHESTRATOR-claude-code.md'))
    assert.ok(/"handoff".*end your turn/.test(prompt) && prompt.includes('retryAfterSec') && prompt.includes('"stopped"'))
    const md = orchestratorMarkdown(mine)
    assert.ok(md.includes('[sdlc:run=r1]') && md.includes('**handoff**') && md.includes('`outputs`') && md.includes('retryAfterSec'))
    assert.ok(md.includes('**Plan** — agent: Planner — **you** (Claude Code)'))
    assert.ok(md.includes('**Implement** — agent: Developer — skills: api-design — in GitHub Copilot'))
  })

  test('files tier: a checkpoint file per harness', () => {
    const mine = { ...input, tier: 'files' as const, harness: { id: 'cline', label: 'Cline' } }
    assert.strictEqual(nextFile(mine), '.sdlc/sessions/PAY-2/next-cline.md')
    assert.ok(launchPrompt(mine).includes('read .sdlc/sessions/PAY-2/next-cline.md'))
    assert.ok(orchestratorMarkdown(mine).includes('Outputs: {"Local.TestsPassed": true}'))
  })
})

suite('Orchestrated runs — quick fixes (a prompt, no story)', () => {
  const quick = {
    runId: 'r2',
    storyKey: null,
    storyTitle: null,
    quickFix: promptSummary('Fix the typo on the checkout button\nIt reads "Pay nwo".'),
    workflowName: 'Quick fix',
    steps: [{ label: 'Implement', agentName: 'Implementer', skills: [], harness: 'claude-code' }],
    sessionDir: '.sdlc/sessions/run-r2',
    tier: 'full' as const,
    harness: { id: 'claude-code', label: 'Claude Code' },
  }

  test('the prompt and protocol name the fix and point at prompt.md', () => {
    assert.ok(launchPrompt(quick).includes('the Quick fix workflow on the quick fix “Fix the typo on the checkout button”'))
    const md = orchestratorMarkdown(quick)
    assert.ok(md.includes('on the quick fix “Fix the typo on the checkout button”'))
    assert.ok(md.includes('.sdlc/sessions/run-r2/prompt.md') && !md.includes('story.md'))
  })

  test('the prompt summary is its first line, shortened', () => {
    assert.strictEqual(promptSummary('  One line  \nmore'), 'One line')
    assert.strictEqual(promptSummary('x'.repeat(100), 10), `${'x'.repeat(9)}…`)
    assert.strictEqual(promptSummary(''), '')
  })

  test('sdlc_get_story returns prompt.md when there is no story', async () => {
    const read: string[] = []
    const files = { read: async (p: string) => (read.push(p), '# Quick fix\n\nFix it') } as unknown as SessionFiles
    const tools = buildSdlcTools({
      runId: 'r2',
      projectKey: 'PAY',
      storyNumber: null,
      sessionDir: '.sdlc/sessions/run-r2',
      steps: new StepChannel(),
      client: () => undefined,
      files,
      activity: () => undefined,
      currentStep: () => undefined,
    })
    const story = tools.find((t) => t.name === 'sdlc_get_story')
    assert.strictEqual(await story?.call({}), '# Quick fix\n\nFix it')
    assert.deepStrictEqual(read, ['.sdlc/sessions/run-r2/prompt.md'])
  })
})

suite('Orchestrated runs — file checkpoints', () => {
  test('done.md lists skills and run variables', () => {
    assert.deepStrictEqual(parseDone('Added the endpoint.\nSkills used: api-design, testing\nOutputs: {"Local.TestsPassed": true}\n'), {
      skillsUsed: ['api-design', 'testing'],
      outputs: { 'Local.TestsPassed': true },
    })
    assert.deepStrictEqual(parseDone('Done.\nOutputs: not json'), { skillsUsed: [] })
  })

  test('the checkpoint text says what to write where', () => {
    const plan = checkpointText('.sdlc/sessions/PAY-2', assignment({ skills: [{ slug: 'api-design', name: 'API design', path: '.sdlc/sessions/PAY-2/skills/api-design.md' }] }))
    assert.ok(plan.includes('PLAN as Planner') && plan.includes('.sdlc/sessions/PAY-2/s1/plan.md') && plan.includes('skills/api-design.md'))
    const exec = checkpointText('.sdlc/sessions/PAY-2', assignment({ action: 'execute', approvedPlan: 'Add POST /refunds' }))
    assert.ok(exec.includes('EXECUTE') && exec.includes('Add POST /refunds') && exec.includes('s1/done.md') && exec.includes('Outputs:'))
  })

  test('the pump writes each new step once and stops when another harness has the next one', async () => {
    const answers: NextStep[] = [assignment(), assignment(), { action: 'handoff', harness: 'copilot', message: 'GitHub Copilot has the next step.' }]
    let i = 0
    const writes: string[] = []
    const pump = new CheckpointPump({
      runId: 'r1',
      source: { poll: async () => answers[Math.min(i++, answers.length - 1)] },
      sessionDir: '.sdlc/sessions/PAY-2',
      write: async (t) => {
        writes.push(t)
      },
      log: () => {},
      checkpointWaitMs: 5,
    })
    pump.start()
    for (let n = 0; n < 200 && pump.running; n++) await new Promise((r) => setTimeout(r, 5))
    assert.strictEqual(pump.running, false)
    assert.strictEqual(writes.length, 2)
    assert.ok(writes[0].includes('PLAN as Planner'))
    assert.ok(writes[1].includes('GitHub Copilot') && writes[1].includes('end your turn'))
  })
})

suite('Orchestrated runs — API client and events', () => {
  function fakeFetch(body: object, seen: Array<{ url: string; init?: RequestInit }>) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, init })
      return new Response(JSON.stringify(body), { status: 200 })
    }
  }

  test('next step long-polls with a deadline', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const client = new PlatformClient({ apiUrl: 'http://api.test' }, fakeFetch({ action: 'handoff', harness: 'copilot', message: 'x' }, seen))
    const next = await client.nextStep('PAY', 'r1', { harness: 'claude-code', clientId: 'window-1234', wait: 25 })
    assert.strictEqual(next.action, 'handoff')
    assert.strictEqual(seen[0].url, 'http://api.test/api/v1/projects/PAY/runs/r1/steps/next?harness=claude-code&wait=25&clientId=window-1234')
    assert.ok(seen[0].init?.signal, 'the long-poll can time out')
  })

  test('plans, completions, approvals and step harnesses use the platform’s endpoints', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const ack = new PlatformClient({ apiUrl: 'http://api.test' }, fakeFetch({ ok: true, stepId: 's1' }, seen))
    await ack.submitPlan('PAY', 'r1', 's1', { plan: 'Add POST /refunds' })
    await ack.completeStep('PAY', 'r1', 's1', { summary: 'Done', skillsUsed: [], outputs: { 'Local.TestsPassed': true } })
    await new PlatformClient({ apiUrl: 'http://api.test' }, fakeFetch({ ok: true, status: 'running' }, seen)).approveRun('PAY', 'r1', {
      approve: false,
      comment: 'Split it',
      stepId: 's1',
    })
    const pinned = await new PlatformClient(
      { apiUrl: 'http://api.test' },
      fakeFetch({ workflowId: 'w1', nodeId: 'n1', harness: 'copilot', version: 4 }, seen),
    ).setStepHarness('PAY', 'w1', 'n1', 'copilot')
    assert.strictEqual(pinned.version, 4)
    assert.deepStrictEqual(
      seen.map((s) => `${s.init?.method} ${s.url.replace('http://api.test/api/v1', '')} ${s.init?.body ?? ''}`),
      [
        'POST /projects/PAY/runs/r1/steps/s1/plan {"plan":"Add POST /refunds"}',
        'POST /projects/PAY/runs/r1/steps/s1/complete {"summary":"Done","skillsUsed":[],"outputs":{"Local.TestsPassed":true}}',
        'POST /projects/PAY/runs/r1/approval {"approve":false,"comment":"Split it","stepId":"s1"}',
        'PUT /projects/PAY/workflows/w1/nodes/n1/harness {"harness":"copilot"}',
      ],
    )
    assert.strictEqual(seen[0].init?.signal, undefined, 'only the long-poll has a deadline')
  })

  test('a step waiting for a harness arrives as a run.step event', () => {
    const frame =
      'event: platform\ndata: {"type":"run.step","targetUserId":"u1","runId":"r1","projectKey":"PAY","storyNumber":2,"stepId":"s1","nodeId":"n1","phase":"plan","harness":"claude-code","clientId":"window-1234"}\n\n'
    const [e] = parseSseFrames(frame).events
    assert.ok(e?.type === 'run.step' && e.harness === 'claude-code' && e.clientId === 'window-1234')
  })
})
