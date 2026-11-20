// Story delivery runs end to end, the pieces VS Code owns: each step's files committed to the run's branch (only the
// step's own, nothing pushed), the changed files' full before/after text sent for the Code page, token usage read
// from Claude Code's transcript, and the Run monitor's markup.
//
// Pure (no `vscode`): runs under the VS Code test host AND under plain mocha (needs `git` on the PATH).

import * as assert from 'assert'
import { execFileSync } from 'child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { buildRunMap } from '@sdlc/core'
import { TranscriptUsage, usageFromLines } from '../../platform/bridge/transcriptUsage'
import { GitCli } from '../../platform/work/gitCli'
import { commitStep, stepCommitMessage } from '../../platform/work/runCommit'
import { fileContents } from '../../platform/work/runChanges'
import { renderRunMonitor } from '../../platform/runMonitor/runMonitorHtml'

const RUN = '00000000-0000-4000-8000-000000000001'

suite('SDLC platform — run delivery', function () {
  this.timeout(60_000)
  let dir: string
  let git: GitCli
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  const write = (file: string, text: string) => writeFileSync(path.join(dir, file), text)

  setup(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sdlc-delivery-'))
    git = new GitCli('git', dir)
    sh('init', '-q', '-b', 'main')
    sh('config', 'user.email', 'dev@example.com')
    sh('config', 'user.name', 'Dev')
    sh('config', 'core.autocrlf', 'false')
    write('a.txt', 'one\n')
    write('b.txt', 'two\n')
    sh('add', '.')
    sh('commit', '-q', '-m', 'start')
  })

  teardown(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      /* the temp folder is cleaned up eventually */
    }
  })

  test('commits only the step’s files, with the story and agent in the message', async () => {
    write('a.txt', 'one changed\n')
    write('new.txt', 'brand new\n')
    write('b.txt', 'user edit, not the step’s\n')
    const sha = await commitStep(git, {
      workKey: 'PAY-12',
      agentName: 'Implementer',
      summary: '## Done\n- Added the refund endpoint\n- Tests',
      paths: ['a.txt', 'new.txt', '.sdlc/sessions/PAY-12/story.md'],
      runId: RUN,
      stepId: 'step-1',
    })
    assert.ok(sha)
    assert.deepStrictEqual(sh('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['a.txt', 'new.txt'])
    assert.strictEqual(sh('log', '-1', '--format=%s').trim(), 'PAY-12 Implementer: Done')
    assert.match(sh('log', '-1', '--format=%b'), /SDLC-Run: 00000000-0000-4000-8000-000000000001/)
    // The user's own edit stays uncommitted.
    assert.match(sh('status', '--porcelain'), /M b\.txt/)
  })

  test('stages deletions, skips paths that exist nowhere, and commits nothing when nothing changed', async () => {
    rmSync(path.join(dir, 'a.txt'))
    const sha = await commitStep(git, { workKey: null, summary: 'Removed a', paths: ['a.txt', 'ghost.txt'], runId: RUN, stepId: 's' })
    assert.ok(sha)
    assert.deepStrictEqual(sh('show', '--name-status', '--format=', 'HEAD').trim(), 'D\ta.txt')
    assert.strictEqual(await commitStep(git, { workKey: null, summary: 'x', paths: ['b.txt'], runId: RUN, stepId: 's2' }), null)
  })

  test('the commit subject skips markdown and falls back when the summary is empty', () => {
    assert.strictEqual(stepCommitMessage({ workKey: null, summary: '', runId: RUN, stepId: 's' }).split('\n')[0], 'Step completed')
    assert.strictEqual(stepCommitMessage({ workKey: 'PAY-1-T2', agentName: 'Tester', summary: '> All tests pass', runId: RUN, stepId: 's' }).split('\n')[0], 'PAY-1-T2 Tester: All tests pass')
  })

  test('sends each changed text file before and after, skipping excluded and binary files', async () => {
    const base = sh('rev-parse', 'HEAD').trim()
    write('a.txt', 'one changed\n')
    write('added.txt', 'hello\n')
    write('.env', 'SECRET=1\n')
    const contents = await fileContents(
      { git, root: dir },
      base,
      [
        { path: 'a.txt', status: 'modified', additions: 1, deletions: 1, binary: false, excluded: false },
        { path: 'added.txt', status: 'untracked', additions: 1, deletions: 0, binary: false, excluded: false },
        { path: 'b.txt', status: 'deleted', additions: 0, deletions: 1, binary: false, excluded: false },
        { path: '.env', status: 'untracked', additions: 1, deletions: 0, binary: false, excluded: false },
        { path: 'logo.png', status: 'added', additions: 0, deletions: 0, binary: true, excluded: false },
      ],
      (p) => p === '.env',
    )
    assert.deepStrictEqual(
      contents.map((c) => [c.path, c.original, c.modified, c.truncated]),
      [
        ['a.txt', 'one\n', 'one changed\n', false],
        ['added.txt', null, 'hello\n', false],
        ['b.txt', 'two\n', null, false],
      ],
    )
  })

  test('reads Claude Code transcript usage incrementally, once per message, ignoring older entries', async () => {
    const file = path.join(dir, 'transcript.jsonl')
    const line = (id: string, at: string, input: number, output: number) =>
      JSON.stringify({ type: 'assistant', timestamp: at, message: { id, usage: { input_tokens: input, cache_read_input_tokens: 10, output_tokens: output } } })
    writeFileSync(file, `${line('old', '2026-01-01T00:00:00Z', 999, 999)}\n${line('m1', '2026-11-19T10:00:01Z', 100, 5)}\n${line('m1', '2026-11-19T10:00:02Z', 100, 40)}\n`)
    const reader = new TranscriptUsage(Date.parse('2026-11-19T10:00:00Z'))
    assert.deepStrictEqual(await reader.read(file), { tokensIn: 110, tokensOut: 40 })
    assert.deepStrictEqual(await reader.read(file), { tokensIn: 0, tokensOut: 0 })
    appendFileSync(file, `${line('m2', '2026-11-19T10:01:00Z', 50, 7)}\n{"partial":`)
    assert.deepStrictEqual(await reader.read(file), { tokensIn: 60, tokensOut: 7 })
    assert.deepStrictEqual(usageFromLines(['not json', '{"message":{}}'], 0, new Map()), { tokensIn: 0, tokensOut: 0 })
  })

  test('the Run monitor renders the agent map, the approval and escapes everything', () => {
    const map = buildRunMap(
      {
        status: 'awaiting_approval',
        startedAt: '2026-11-19T10:00:00Z',
        finishedAt: null,
        workflowName: 'Story delivery',
        pendingApproval: { stepId: 's1', question: 'Approve <plan>?' },
        tokensIn: 0,
        tokensOut: 0,
      },
      [
        {
          stepId: 's1',
          nodeId: 'plan',
          seq: 1,
          kind: 'agent',
          label: 'Plan',
          status: 'running',
          startedAt: '2026-11-19T10:00:01Z',
          finishedAt: null,
          agentName: 'Planner',
          engine: 'claude-code',
          tokensIn: 1200,
          tokensOut: 300,
          toolCalls: 3,
          changedFiles: [],
        },
      ],
      [],
      [
        { id: 't', kind: 'trigger', label: 'Story picked up' },
        { id: 'plan', kind: 'agent', label: 'Plan' },
      ],
      Date.parse('2026-11-19T10:05:00Z'),
    )
    const html = renderRunMonitor({
      connected: true,
      runs: [{ runId: RUN, projectKey: 'PAY', label: 'PAY-12', status: 'awaiting_approval' }],
      followed: { runId: RUN, projectKey: 'PAY', label: 'PAY-12', status: 'awaiting_approval' },
      map,
      pending: { stepId: 's1', question: 'Approve <plan>?', context: '1. Do <x>', kind: 'plan', agentName: 'Planner' },
      error: null,
    })
    assert.match(html, /Orchestrator · Story delivery/)
    assert.match(html, /Planner/)
    assert.match(html, /Claude Code · 4m 59s · 1\.5k tokens/)
    assert.match(html, /Approve &lt;plan&gt;\?/)
    assert.match(html, /1\. Do &lt;x&gt;/)
    assert.match(html, /data-action="approve" data-step="s1"/)
    assert.doesNotMatch(html, /<plan>/)
  })
})
