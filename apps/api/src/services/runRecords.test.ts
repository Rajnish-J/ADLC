// Unit tests for the pure parts of run records: the captured run summary, stats across runs, the steps a run
// planned, and the AI summary's input and parsing. Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProjectRunDetailSchema, type ChangedFile, type User } from '@sdlc/contracts'
import { STORY_DELIVERY_SPEC } from '@sdlc/core'
import { runSummaryContent, type CapturedStep } from './memoryCapture'
import { formatMemoryContext } from './memoryContext'
import { insightHash, insightInput, parseInsight } from './runInsights'
import { runStepContext, summarizeRunStats, type StatsRun } from './runRecords'

const step = (over: Partial<CapturedStep>): CapturedStep => ({
  stepId: 's1',
  kind: 'agent',
  label: 'Implement',
  status: 'succeeded',
  seq: 1,
  output: null,
  gatePass: null,
  gateReason: null,
  approval: null,
  ...over,
})

const file = (path: string, additions: number, deletions: number, status: ChangedFile['status'] = 'modified'): ChangedFile => ({
  path,
  status,
  additions,
  deletions,
  binary: false,
  excluded: false,
})

describe('run summary memory', () => {
  const run = { id: 'r', workflowName: 'Quick fix', status: 'completed', changedFiles: ['a.ts'], prompt: 'Fix the login button' }

  it('leads a quick fix with its prompt, then the last agent output and files with line counts', () => {
    const text = runSummaryContent(
      run,
      [step({ seq: 1, label: 'Plan', output: 'old' }), step({ seq: 2, label: 'Implement', output: 'Changed the button.' })],
      [file('src/a.ts', 3, 1), file('src/b.ts', 10, 0, 'added')],
      true,
    )
    assert.match(text, /^Prompt:\nFix the login button\n/)
    assert.match(text, /Implement:\nChanged the button\./)
    assert.ok(!text.includes('old'))
    assert.match(text, /Files changed \(\+13 −1\):/)
    assert.match(text, /- src\/b\.ts \(\+10 −0\) — new/)
  })

  it('falls back to bare paths, and leaves the prompt out for a story run', () => {
    const text = runSummaryContent(run, [], null, false)
    assert.equal(text, 'Files changed:\n- a.ts')
    assert.equal(runSummaryContent({ ...run, changedFiles: [] }, [], null, false), 'The run completed.')
  })
})

describe('memory context', () => {
  it('names the subject and lists the item ids it included', () => {
    const ctx = formatMemoryContext('the PAY project', [
      { heading: 'Pinned', items: [{ id: '00000000-0000-4000-8000-000000000001', kind: 'convention', title: 'Use zod', content: 'Always.', fileRefs: [] }] },
    ])
    assert.match(ctx.markdown, /^Knowledge recorded on the SDLC platform for the PAY project\./)
    assert.deepEqual(ctx.itemIds, ['00000000-0000-4000-8000-000000000001'])
  })
})

describe('run stats', () => {
  const now = new Date('2026-11-18T12:00:00Z')
  const ana: User = { id: 'u1', email: 'a@x', displayName: 'Ana', orgRole: 'member' }
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000)
  const rows: StatsRun[] = [
    { id: 'a', status: 'completed', engine: 'claude-code', userId: 'u1', startedAt: at(5), finishedAt: at(4), changedFiles: ['x.ts', 'y.ts'] },
    { id: 'b', status: 'completed', engine: 'claude-code', userId: 'u1', startedAt: at(30), finishedAt: at(27), changedFiles: ['x.ts'] },
    { id: 'c', status: 'failed', engine: 'copilot', userId: 'u1', startedAt: at(2), finishedAt: at(1), changedFiles: [] },
    { id: 'd', status: 'running', engine: 'copilot', userId: null, startedAt: at(1), finishedAt: null, changedFiles: [] },
  ]
  const stats = summarizeRunStats(rows, [{ runId: 'a', files: 2, additions: 20, deletions: 5 }], new Map([['u1', ana]]), 7, now)

  it('totals, success rate and median duration of completed runs', () => {
    assert.equal(stats.totals.runs, 4)
    assert.equal(stats.totals.completed, 2)
    assert.equal(stats.totals.failed, 1)
    assert.equal(stats.totals.active, 1)
    assert.equal(stats.totals.successRate, 2 / 3)
    assert.equal(stats.totals.medianDurationMs, 2 * 3_600_000)
    assert.equal(stats.totals.filesChanged, 3)
    assert.equal(stats.totals.additions, 20)
  })

  it('one row per day, oldest first, ending today', () => {
    assert.equal(stats.perDay.length, 7)
    assert.equal(stats.perDay.at(-1)?.date, '2026-11-18')
    assert.equal(stats.perDay.at(-1)?.completed, 1)
    assert.equal(stats.perDay.at(-2)?.completed, 1)
  })

  it('per person, per harness and hotspots', () => {
    assert.deepEqual(stats.perUser.map((u) => [u.user.displayName, u.runs, u.completed, u.failed]), [['Ana', 3, 2, 1]])
    assert.deepEqual(stats.perHarness.map((h) => [h.engine, h.runs]), [['claude-code', 2], ['copilot', 2]])
    assert.deepEqual(stats.hotspots[0], { path: 'x.ts', runs: 2 })
  })
})

describe('run step context', () => {
  it('reads agents, skills and harness from the workflow the run started with', () => {
    const steps = runStepContext(STORY_DELIVERY_SPEC, [], 'claude-code')
    assert.ok(steps.length >= 3)
    assert.equal(steps[0].agentSlug, 'planner')
    assert.equal(steps[0].harness, 'claude-code')
  })

  it('falls back to the reported agent steps', () => {
    const steps = runStepContext(null, [{ kind: 'agent', nodeId: 'n', label: 'Do', agentSlug: 'x', agentName: 'X', skills: ['s'], engine: null }, { kind: 'gate', nodeId: 'g', label: 'G', agentSlug: null, agentName: null, skills: [], engine: null }], 'copilot')
    assert.deepEqual(steps, [{ nodeId: 'n', label: 'Do', agentSlug: 'x', agentName: 'X', skills: ['s'], harness: 'copilot' }])
  })
})

describe('run insight', () => {
  const detail = ProjectRunDetailSchema.parse({
    id: '00000000-0000-4000-8000-0000000000aa',
    clientRunId: 'c',
    origin: 'web',
    driver: 'orchestrator',
    workflowName: 'Quick fix',
    workflowId: null,
    workflowVersion: null,
    engine: 'claude-code',
    engineModel: null,
    task: null,
    prompt: 'Fix the login button',
    requestedBy: null,
    requestedAt: null,
    claimedAt: null,
    clientId: null,
    status: 'failed',
    startedBy: null,
    startedAt: '2026-11-18T10:00:00Z',
    finishedAt: '2026-11-18T10:05:00Z',
    error: 'Gate failed',
    pendingApproval: null,
    tokensIn: 0,
    tokensOut: 0,
    changedFiles: ['apps/web/src/Login.tsx'],
    story: null,
    stepCount: 0,
    gatesPassed: 0,
    gatesFailed: 1,
    agentsUsed: [],
    skillsUsed: [],
    kind: 'quick',
    steps: [],
    changes: {
      branch: 'quick/fix',
      baseSha: 'abc',
      headSha: 'def',
      files: [file('apps/web/src/Login.tsx', 12, 3), file('apps/api/drizzle/0017_x.sql', 5, 0, 'added')],
      additions: 17,
      deletions: 3,
      hasPatch: true,
      patchTruncated: false,
      commits: [],
      updatedAt: '2026-11-18T10:05:00Z',
    },
  })

  it('describes the run, its changes and flags', () => {
    const input = insightInput(detail)
    assert.match(input, /Quick fix \(no story\)/)
    assert.match(input, /Prompt: Fix the login button/)
    assert.match(input, /2 files, \+17 −3 lines/)
    assert.match(input, /Flag \[high\] Database migration/)
    assert.match(input, /- apps\/web\/src\/Login\.tsx \[modified\] \+12 −3/)
  })

  it('hashes the same record the same way, and a changed record differently', () => {
    assert.equal(insightHash(insightInput(detail)), insightHash(insightInput(detail)))
    assert.notEqual(insightHash(insightInput(detail)), insightHash(insightInput({ ...detail, status: 'completed' })))
  })

  it('splits the answer into impact and failure', () => {
    assert.deepEqual(parseInsight('## Impact\nChanged login.\n\n## Why it failed\nThe gate.'), { impact: 'Changed login.', failure: 'The gate.' })
    assert.deepEqual(parseInsight('Changed login.'), { impact: 'Changed login.', failure: null })
  })
})
