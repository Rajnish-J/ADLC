// Code activity: which story a branch belongs to, parsing git output, keeping secrets out of reported diffs, and
// mapping a local run to the snapshot the platform stores.
//
// Pure (no `vscode`): runs under the VS Code test host AND under plain mocha.

import * as assert from 'assert'
import { resolveStory, storyFromBranch, storyFromKey } from '../../platform/work/storyRef'
import {
  DEFAULT_DIFF_EXCLUDE,
  globToRegExp,
  looksBinary,
  makeExcluder,
  mergeFileStats,
  parseLog,
  parseNameStatusZ,
  parseNumstatZ,
  safePatch,
  splitPatch,
  syntheticAddPatch,
} from '../../platform/work/gitParse'
import { toRunReport } from '../../platform/work/runSnapshot'
import type { RunState } from '../../runtime/port'

suite('SDLC platform — story branches', () => {
  test('story keys parse case-insensitively', () => {
    assert.deepStrictEqual(storyFromKey('PAY-2'), { projectKey: 'PAY', number: 2 })
    assert.deepStrictEqual(storyFromKey(' pay-12 '), { projectKey: 'PAY', number: 12 })
    assert.strictEqual(storyFromKey('PAY'), undefined)
    assert.strictEqual(storyFromKey('2-PAY'), undefined)
  })

  test('branches named for a story map to it', () => {
    assert.deepStrictEqual(storyFromBranch('story/PAY-2-refund-api-endpoint'), { projectKey: 'PAY', number: 2 })
    assert.deepStrictEqual(storyFromBranch('story/PAY-2'), { projectKey: 'PAY', number: 2 })
    assert.deepStrictEqual(storyFromBranch('feature/onb-14-kyc'), { projectKey: 'ONB', number: 14 })
    assert.deepStrictEqual(storyFromBranch('refs/heads/story/PAY-3-x'), { projectKey: 'PAY', number: 3 })
  })

  test('other branches do not', () => {
    for (const b of ['main', 'develop', 'PAY-2', 'fix-PAY-2', 'story/refund', 'release/2024-11']) {
      assert.strictEqual(storyFromBranch(b), undefined, b)
    }
  })

  test('an explicit link wins over the naming convention', () => {
    assert.deepStrictEqual(resolveStory('story/PAY-2-x', { 'story/PAY-2-x': 'ONB-1' }), { projectKey: 'ONB', number: 1 })
    assert.deepStrictEqual(resolveStory('my-experiment', { 'my-experiment': 'PAY-5' }), { projectKey: 'PAY', number: 5 })
    assert.strictEqual(resolveStory('my-experiment', {}), undefined)
  })
})

suite('SDLC platform — git output', () => {
  test('name-status -z, including renames', () => {
    const out = 'M\0src/a.ts\0A\0src/new file.ts\0R087\0old/x.ts\0new/x.ts\0D\0gone.ts\0'
    assert.deepStrictEqual(parseNameStatusZ(out), [
      { status: 'modified', path: 'src/a.ts' },
      { status: 'added', path: 'src/new file.ts' },
      { status: 'renamed', path: 'new/x.ts', oldPath: 'old/x.ts' },
      { status: 'deleted', path: 'gone.ts' },
    ])
  })

  test('numstat -z, including renames and binary files', () => {
    const stats = parseNumstatZ('3\t1\tsrc/a.ts\0' + '10\t2\t\0old/x.ts\0new/x.ts\0' + '-\t-\tlogo.png\0')
    assert.deepStrictEqual(stats.get('src/a.ts'), { additions: 3, deletions: 1, binary: false })
    assert.deepStrictEqual(stats.get('new/x.ts'), { additions: 10, deletions: 2, binary: false })
    assert.deepStrictEqual(stats.get('logo.png'), { additions: 0, deletions: 0, binary: true })
  })

  test('file lists join both and flag excluded files', () => {
    const files = mergeFileStats(
      [
        { status: 'modified', path: 'src/a.ts' },
        { status: 'modified', path: '.env' },
      ],
      new Map([['src/a.ts', { additions: 3, deletions: 1, binary: false }]]),
      makeExcluder(DEFAULT_DIFF_EXCLUDE),
    )
    assert.deepStrictEqual(files[0], { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, binary: false, excluded: false })
    assert.strictEqual(files[1].excluded, true)
  })

  test('log records split on the record separator, with multi-line messages', () => {
    const sha1 = 'a'.repeat(40)
    const sha2 = 'b'.repeat(40)
    const out = `\x1e${sha1}\x1fDevi\x1fdev1@x\x1f2026-11-05T10:00:00+05:30\x1fAdd refunds\n\nBody line\n\x1e${sha2}\x1fDevi\x1fdev1@x\x1f2026-11-05T11:00:00+05:30\x1fFix\n`
    const log = parseLog(out)
    assert.strictEqual(log.length, 2)
    assert.deepStrictEqual(log[0], { sha: sha1, authorName: 'Devi', authorEmail: 'dev1@x', committedAt: '2026-11-05T10:00:00+05:30', message: 'Add refunds\n\nBody line' })
    assert.strictEqual(log[1].message, 'Fix')
  })
})

suite('SDLC platform — safe diffs', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/.env b/.env',
    '--- a/.env',
    '+++ b/.env',
    '@@ -1 +1 @@',
    '-API_KEY=old',
    '+API_KEY=supersecret',
    '',
  ].join('\n')

  test('globs: ** spans folders, * stays in one, braces alternate', () => {
    assert.ok(globToRegExp('**/.env').test('.env'))
    assert.ok(globToRegExp('**/.env').test('apps/api/.env'))
    assert.ok(globToRegExp('**/.env.*').test('apps/web/.env.local'))
    assert.ok(globToRegExp('**/*.{pem,key}').test('certs/server.key'))
    assert.ok(!globToRegExp('src/*.ts').test('src/deep/a.ts'))
    assert.ok(!globToRegExp('**/.env').test('docs/env.md'))
  })

  test('patches split per file', () => {
    assert.deepStrictEqual(
      splitPatch(patch).map((s) => s.path),
      ['src/a.ts', '.env'],
    )
  })

  test('excluded files never leave the machine', () => {
    const safe = safePatch(patch, makeExcluder(DEFAULT_DIFF_EXCLUDE), 10_000)
    assert.ok(safe.patch?.includes('+new'))
    assert.ok(!safe.patch?.includes('supersecret'))
    assert.strictEqual(safe.truncated, false)
  })

  test('large patches are cut at whole files and flagged', () => {
    const safe = safePatch(patch, () => false, 80)
    assert.strictEqual(safe.truncated, true)
    assert.ok((safe.patch ?? '').length <= 81)
    assert.ok(!safe.patch?.includes('.env'))
  })

  test('nothing left to send is null', () => {
    assert.deepStrictEqual(safePatch(patch, () => true, 10_000), { patch: null, truncated: false })
  })

  test('untracked files become "new file" patches', () => {
    const added = syntheticAddPatch('src/new.ts', 'one\r\ntwo\n')
    assert.strictEqual(added.additions, 2)
    assert.ok(added.patch.startsWith('diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two'))
    assert.ok(looksBinary(new Uint8Array([0x50, 0x00, 0x4b])))
    assert.ok(!looksBinary(new TextEncoder().encode('plain text')))
  })
})

suite('SDLC platform — run snapshots', () => {
  test('a run maps to the report with per-step files and approvals, outputs clipped', () => {
    const state: RunState = {
      runId: 'r1',
      workflowName: 'Story delivery',
      status: 'awaiting_approval',
      actor: 'dev1@sdlc.local',
      inputs: { storyKey: 'PAY-2' },
      startedAt: Date.parse('2026-11-05T10:00:00Z'),
      pendingApproval: { stepId: 's2', nodeId: 'merge', question: 'Ready to merge?' },
      steps: [
        { id: 's1', nodeId: 'implement', kind: 'agent', label: 'Implement', seq: 1, status: 'succeeded', output: 'x'.repeat(9_000), tokensIn: 10.4, tokensOut: 5, startedAt: Date.parse('2026-11-05T10:00:01Z'), finishedAt: Date.parse('2026-11-05T10:01:00Z') },
        { id: 's2', nodeId: 'gate', kind: 'gate', label: 'Quality gate', seq: 2, status: 'failed', gateDecision: { pass: false, perEvaluator: [{ evaluator: 'coherence', score: 2.5, threshold: 3, required: true, pass: false, reason: 'below threshold' }, { evaluator: 'violence', score: null, threshold: null, required: false, pass: true, reason: 'no score' }], reason: 'Coverage below 80%', reportUrl: 'https://ai.azure.com/report/1' }, startedAt: Date.parse('2026-11-05T10:01:01Z') },
      ],
    }
    const report = toRunReport(state, {
      changedFiles: new Map([['s1', ['src/refund.ts']]]),
      approvals: new Map([['s1', { approve: true, actor: 'lead@sdlc.local' }]]),
    })
    assert.strictEqual(report.status, 'awaiting_approval')
    assert.strictEqual(report.startedAt, '2026-11-05T10:00:00.000Z')
    assert.deepStrictEqual(report.pendingApproval, { stepId: 's2', question: 'Ready to merge?' })
    const [s1, s2] = report.steps
    assert.deepStrictEqual(s1.changedFiles, ['src/refund.ts'])
    assert.deepStrictEqual(s1.approval, { approve: true, actor: 'lead@sdlc.local' })
    assert.strictEqual(s1.tokensIn, 10)
    assert.ok((s1.output ?? '').length <= 8_001)
    assert.strictEqual(s2.gatePass, false)
    assert.strictEqual(s2.gateReason, 'Coverage below 80%')
    assert.strictEqual(s2.finishedAt, null)
    assert.deepStrictEqual(s2.evaluations, [
      { evaluator: 'coherence', score: 2.5, threshold: 3, pass: false, required: true, reason: 'below threshold' },
      { evaluator: 'violence', score: null, threshold: null, pass: true, required: false, reason: 'no score' },
    ])
    assert.strictEqual(s2.reportUrl, 'https://ai.azure.com/report/1')
    assert.deepStrictEqual(s1.evaluations, [])
    assert.strictEqual(s1.reportUrl, null)
  })
})
