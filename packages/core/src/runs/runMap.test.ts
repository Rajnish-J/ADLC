import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRunMap, formatElapsed, runProgress, formatTokens, type RunMapEventInput, type RunMapRunInput, type RunMapStepInput } from './runMap'

const T0 = Date.parse('2026-11-19T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const run = (extra: Partial<RunMapRunInput> = {}): RunMapRunInput => ({
  status: 'running',
  startedAt: at(0),
  finishedAt: null,
  workflowName: 'Story delivery',
  pendingApproval: null,
  tokensIn: 0,
  tokensOut: 0,
  ...extra,
})

const step = (seq: number, extra: Partial<RunMapStepInput> = {}): RunMapStepInput => ({
  stepId: `s${seq}`,
  nodeId: `n${seq}`,
  seq,
  kind: 'agent',
  label: `Step ${seq}`,
  status: 'succeeded',
  startedAt: at(seq * 10),
  finishedAt: at(seq * 10 + 5),
  agentName: `Agent ${seq}`,
  engine: 'claude-code',
  tokensIn: null,
  tokensOut: null,
  toolCalls: null,
  changedFiles: [],
  ...extra,
})

let seq = 0
const ev = (type: string, stepId: string | null, extra: Partial<RunMapEventInput> = {}): RunMapEventInput => ({
  seq: ++seq,
  at: at(seq),
  type,
  stepId,
  agentType: null,
  agentName: null,
  tool: null,
  path: null,
  summary: null,
  data: {},
  ...extra,
})

test('a running step shows its activity, tools, files, tokens and subagents', () => {
  const steps = [step(1), step(2, { status: 'running', finishedAt: null, tokensIn: 100, tokensOut: 20, changedFiles: ['a.ts'] })]
  const events = [
    ev('tool.called', 's2', { tool: 'Read', path: 'src/x.ts' }),
    ev('agent.started', 's2', { agentType: 'Explore', agentName: 'Explore' }),
    ev('usage', 's2', { data: { tokensIn: 400, tokensOut: 50 } }),
    ev('file.changed', 's2', { tool: 'Edit', path: 'b.ts' }),
    ev('tool.called', 's2', { tool: 'Edit', path: 'b.ts' }),
  ]
  const map = buildRunMap(run(), steps, events, null, T0 + 60_000)
  const n = map.nodes[1]
  assert.equal(n.status, 'running')
  assert.equal(n.toolCalls, 2)
  assert.equal(n.files, 2)
  assert.equal(n.tokens, 450) // usage events exceed what the step recorded
  assert.equal(n.lastActivity, 'Edit b.ts')
  assert.deepEqual(
    n.subAgents.map((a) => [a.name, a.status]),
    [['Explore', 'running']],
  )
  assert.equal(map.currentNodeId, 'n2')
  assert.equal(map.orchestrator.status, 'running')
  assert.equal(map.orchestrator.activity, 'Edit b.ts')
  assert.equal(map.orchestrator.elapsedMs, 60_000)
})

test('the step a run waits on is "waiting", with the question as its activity', () => {
  const steps = [step(1, { status: 'running', finishedAt: null })]
  const map = buildRunMap(run({ status: 'awaiting_approval', pendingApproval: { stepId: 's1', question: 'Approve the plan?' } }), steps, [], null, T0 + 30_000)
  assert.equal(map.nodes[0].status, 'waiting')
  assert.equal(map.nodes[0].lastActivity, 'Approve the plan?')
  assert.equal(map.orchestrator.status, 'waiting')
})

test('a queue nudge marks the run queued until it starts working', () => {
  const queued = buildRunMap(run(), [], [ev('nudge', null, { data: { queued: true, behind: 'PAY-1' } })])
  assert.equal(queued.orchestrator.status, 'queued')
  assert.equal(queued.orchestrator.activity, 'Queued in VS Code behind PAY-1')
  const started = buildRunMap(run(), [], [ev('nudge', null, { data: { queued: true, behind: 'PAY-1' } }), ev('session.started', null)])
  assert.equal(started.orchestrator.status, 'running')
})

test('the flow marks done, active and pending workflow nodes', () => {
  const steps = [step(1), step(2, { status: 'running', finishedAt: null })]
  const spec = [
    { id: 't', kind: 'trigger', label: 'Start' },
    { id: 'n1', kind: 'agent', label: 'Plan' },
    { id: 'n2', kind: 'agent', label: 'Implement' },
    { id: 'n3', kind: 'gate', label: 'Gate' },
    { id: 'e', kind: 'end', label: 'Done' },
  ]
  const map = buildRunMap(run(), steps, [], spec)
  assert.deepEqual(
    map.flow.map((f) => f.state),
    ['done', 'done', 'running', 'pending', 'pending'],
  )
})

test('progress counts agent, gate and approval steps: "Step 2 of 3"', () => {
  const spec = [
    { id: 't', kind: 'trigger', label: 'Start' },
    { id: 'n1', kind: 'agent', label: 'Plan' },
    { id: 'n2', kind: 'agent', label: 'Implement' },
    { id: 'n3', kind: 'gate', label: 'Gate' },
    { id: 'e', kind: 'end', label: 'Done' },
  ]
  const live = runProgress(buildRunMap(run(), [step(1), step(2, { status: 'running', finishedAt: null })], [], spec))
  assert.deepEqual(live, { index: 2, total: 3, label: 'Implement', state: 'running' })
  const between = runProgress(buildRunMap(run(), [step(1), step(2)], [], spec))
  assert.equal(between.index, 2)
  assert.equal(between.label, null)
  assert.equal(runProgress(buildRunMap(run(), [], [], null)).total, 0)
})

test('formatters', () => {
  assert.equal(formatElapsed(42_000), '42s')
  assert.equal(formatElapsed(292_000), '4m 52s')
  assert.equal(formatTokens(null), '—')
  assert.equal(formatTokens(182_700), '183k')
  assert.equal(formatTokens(9_500), '9.5k')
})
