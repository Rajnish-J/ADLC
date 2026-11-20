// What a run changed, against a real temporary git repository: the run-level diff against the commit the run started
// from (ignoring files that were already dirty and left alone), the files each step changed, commits made during
// the run, and secrets kept out of the diff. Also: hook paths made relative to the workspace.
//
// Pure (no `vscode`): runs under the VS Code test host AND under plain mocha (needs `git` on the PATH).

import * as assert from 'assert'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import type { ReportRunChangesInput } from '@sdlc/contracts'
import { normalizeHook, relativePath } from '../../platform/bridge/hookNormalizer'
import { GitCli } from '../../platform/work/gitCli'
import { excludeEntries, makeExcluder, DEFAULT_DIFF_EXCLUDE } from '../../platform/work/gitParse'
import { RunChangeTracker, type RunChangeStore } from '../../platform/work/runChanges'

const RUN = '00000000-0000-4000-8000-000000000001'

class MemoryStore implements RunChangeStore {
  private readonly data = new Map<string, unknown>()
  get<T>(key: string, fallback: T): T {
    return (this.data.has(key) ? this.data.get(key) : fallback) as T
  }
  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.parse(JSON.stringify(value)))
    return Promise.resolve()
  }
}

suite('SDLC platform — run changes', function () {
  // Every snapshot runs several git commands, which is slow on Windows.
  this.timeout(60_000)
  let dir: string
  let git: GitCli
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  const write = (file: string, text: string) => writeFileSync(path.join(dir, file), text)

  setup(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sdlc-run-'))
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
      // Under the VS Code test host something may still hold the folder; it is in the temp folder anyway.
    }
  })

  function tracker(store = new MemoryStore()) {
    const reports: ReportRunChangesInput[] = []
    const t = new RunChangeTracker({
      client: () => ({ reportRunChanges: async (_k, _r, input) => (reports.push(input), { ok: true as const, files: input.files.length }) }),
      store,
      settings: () => ({ shareDiffs: true, exclude: makeExcluder(DEFAULT_DIFF_EXCLUDE) }),
      log: () => undefined,
    })
    return { t, reports, store }
  }

  test('the run-level diff, the step files, commits and untouched pre-existing edits', async () => {
    write('b.txt', 'two\nlocal edit before the run\n')
    const { t } = tracker()
    const base = await t.begin(RUN, { git, root: dir, branch: () => 'quick/fix-abc' })
    assert.ok(base && /^[0-9a-f]{40}$/.test(base))

    // Step 1: edit a.txt, add c.txt. b.txt was dirty before the run and is left alone, so it isn't the run's.
    write('a.txt', 'one\nchanged by the agent\n')
    write('c.txt', 'new\nfile\n')
    const s1 = await t.snapshot(RUN)
    assert.ok(s1)
    assert.deepStrictEqual(s1.report.files.map((f) => f.path).sort(), ['a.txt', 'c.txt'])
    assert.deepStrictEqual([...s1.stepFiles].sort(), ['a.txt', 'c.txt'])
    assert.strictEqual(s1.report.baseSha, base)
    assert.strictEqual(s1.report.branch, 'quick/fix-abc')
    assert.ok(s1.report.patch?.includes('+changed by the agent'))
    assert.ok(!s1.report.patch?.includes('local edit before the run'))
    assert.strictEqual(s1.report.files.find((f) => f.path === 'c.txt')?.additions, 2)

    // Step 2: commit a.txt (its content doesn't change), touch b.txt again: only b.txt is this step's.
    sh('add', 'a.txt')
    sh('commit', '-q', '-m', 'agent: change a')
    write('b.txt', 'two\nlocal edit before the run\nand the agent too\n')
    const s2 = await t.snapshot(RUN)
    assert.ok(s2)
    assert.deepStrictEqual(s2.stepFiles, ['b.txt'])
    assert.deepStrictEqual(s2.report.files.map((f) => f.path).sort(), ['a.txt', 'b.txt', 'c.txt'])
    const commits = s2.report.commits ?? []
    assert.strictEqual(commits.length, 1)
    assert.strictEqual(commits[0].message, 'agent: change a')
    assert.strictEqual(commits[0].files, 1)

    // Step 3: the agent removes c.txt again — a step that reverted a file still changed it.
    unlinkSync(path.join(dir, 'c.txt'))
    const s3 = await t.snapshot(RUN)
    assert.ok(s3)
    assert.deepStrictEqual(s3.stepFiles, ['c.txt'])
    assert.ok(!s3.report.files.some((f) => f.path === 'c.txt'))
  })

  test('secrets are listed but their content never sent; reports go to the platform; a resumed run keeps its start', async () => {
    const store = new MemoryStore()
    const first = tracker(store)
    const base = await first.t.begin(RUN, { git, root: dir, branch: () => 'main' })
    write('.env', 'API_KEY=secret\n')
    write('a.txt', 'one\nedit\n')
    const files = await first.t.report('PAY', RUN)
    assert.deepStrictEqual(files?.sort(), ['.env', 'a.txt'])
    assert.strictEqual(first.reports.length, 1)
    const env = first.reports[0].files.find((f) => f.path === '.env')
    assert.strictEqual(env?.excluded, true)
    assert.ok(!first.reports[0].patch?.includes('API_KEY'))

    // VS Code restarted: a new tracker over the same workspace state resumes from the same commit.
    sh('add', '.')
    sh('commit', '-q', '-m', 'more')
    const second = tracker(store)
    assert.strictEqual(await second.t.begin(RUN, { git, root: dir, branch: () => 'main' }), base)
    await second.t.end('PAY', RUN)
    assert.strictEqual(second.reports.length, 1)
    assert.strictEqual(second.reports[0].baseSha, base)
    assert.deepStrictEqual(second.reports[0].files.map((f) => f.path).sort(), ['.env', 'a.txt'])
  })

  test('a step whose completion is retried gets its files again; the next step only its own', async () => {
    const { t } = tracker()
    await t.begin(RUN, { git, root: dir, branch: () => 'main' })
    write('a.txt', 'one\nstep one\n')
    assert.deepStrictEqual((await t.snapshot(RUN, 's1'))?.stepFiles, ['a.txt'])
    // completeStep failed; the harness completes s1 again (and touched one more file meanwhile).
    write('c.txt', 'late\n')
    assert.deepStrictEqual((await t.snapshot(RUN, 's1'))?.stepFiles.sort(), ['a.txt', 'c.txt'])
    // s2 starts from where s1 ended.
    write('b.txt', 'two\nstep two\n')
    assert.deepStrictEqual((await t.snapshot(RUN, 's2'))?.stepFiles, ['b.txt'])
  })

  test('after a reload, the next step gets only what changed since the last completed step', async () => {
    const store = new MemoryStore()
    const first = tracker(store)
    await first.t.begin(RUN, { git, root: dir, branch: () => 'main' })
    write('a.txt', 'one\nstep one\n')
    await first.t.snapshot(RUN, 's1')
    write('b.txt', 'two\nstep two\n')
    await first.t.snapshot(RUN, 's2') // settles s1
    await first.t.snapshot(RUN) // a final (non-step) snapshot settles s2

    const second = tracker(store)
    await second.t.begin(RUN, { git, root: dir, branch: () => 'main' })
    write('c.txt', 'step three\n')
    assert.deepStrictEqual((await second.t.snapshot(RUN, 's3'))?.stepFiles, ['c.txt'])
  })

  test('a window that lost the run still sends the final report when it can find the repository', async () => {
    const store = new MemoryStore()
    await tracker(store).t.begin(RUN, { git, root: dir, branch: () => 'main' })
    write('a.txt', 'one\nedit\n')
    const reports: ReportRunChangesInput[] = []
    const reloaded = new RunChangeTracker({
      client: () => ({ reportRunChanges: async (_k, _r, input) => (reports.push(input), { ok: true as const, files: input.files.length }) }),
      store,
      settings: () => ({ shareDiffs: true, exclude: makeExcluder(DEFAULT_DIFF_EXCLUDE) }),
      log: () => undefined,
      resolveRepo: async () => ({ git, root: dir, branch: () => 'main' }),
    })
    await reloaded.end('PAY', RUN)
    assert.strictEqual(reports.length, 1)
    assert.deepStrictEqual(reports[0].files.map((f) => f.path), ['a.txt'])
  })

  test('a diff too large for the buffer is reported without its patch, marked truncated', async () => {
    const tiny = new GitCli('git', dir)
    const run = tiny.run.bind(tiny)
    // Every `git diff` that prints the patch overflows; the name/numstat listings still work.
    tiny.run = (args: string[], maxBuffer?: number) => (args[0] === 'diff' && args[1] === '--no-ext-diff' ? Promise.reject(new Error('maxBuffer exceeded')) : run(args, maxBuffer))
    const big = tracker()
    await big.t.begin(RUN, { git: tiny, root: dir, branch: () => 'main' })
    write('a.txt', `${'x'.repeat(200)}\n`.repeat(50))
    const s = await big.t.snapshot(RUN)
    assert.deepStrictEqual(s?.report.files.map((f) => f.path), ['a.txt'])
    assert.strictEqual(s?.report.patch, null)
    assert.strictEqual(s?.report.patchTruncated, true)
  })

  test('an unknown run has no snapshot', async () => {
    const { t } = tracker()
    assert.strictEqual(await t.snapshot('nope'), undefined)
    assert.strictEqual(await t.report('PAY', 'nope'), undefined)
  })
})

suite('SDLC platform — hook paths', () => {
  test('files outside the workspace are never named in activity; skills read from the home folder still count', () => {
    const edit = (file_path: string) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path }, tool_response: {} })
    const inside = normalizeHook('claude-code', edit('C:\\work\\repo\\src\\a.ts'), undefined, 'C:\\work\\repo')
    assert.deepStrictEqual(inside.map((e) => [e.type, e.path]), [['tool.called', 'src/a.ts'], ['file.changed', 'src/a.ts']])
    const outside = normalizeHook('claude-code', edit('C:\\Users\\dev\\notes.txt'), undefined, 'C:\\work\\repo')
    assert.deepStrictEqual(outside.map((e) => [e.type, e.path]), [['tool.called', null]])
    const read = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\dev\\.claude\\skills\\sdlc-review\\SKILL.md' }, tool_response: {} }
    const skill = normalizeHook('claude-code', read, undefined, 'C:\\work\\repo').find((e) => e.type === 'skill.used')
    assert.strictEqual(skill?.skill, 'review')
  })

  test('info/exclude entries are anchored at the repository root', () => {
    assert.deepStrictEqual(excludeEntries(['.mcp.json', '.sdlc/sessions/PAY-2/']), ['/.mcp.json', '/.sdlc/sessions/PAY-2/'])
    assert.deepStrictEqual(excludeEntries(['.mcp.json', '.mcp.json'], 'apps/web/'), ['/apps/web/.mcp.json'])
    assert.deepStrictEqual(excludeEntries(['/.claude\\settings.local.json'], '\\apps\\web'), ['/apps/web/.claude/settings.local.json'])
  })

  test('absolute paths inside the workspace become relative', () => {
    assert.strictEqual(relativePath('C:\\work\\repo\\src\\a.ts', 'c:\\Work\\Repo'), 'src/a.ts')
    assert.strictEqual(relativePath('/home/dev/repo/src/a.ts', '/home/dev/repo/'), 'src/a.ts')
    assert.strictEqual(relativePath('src/a.ts', '/home/dev/repo'), 'src/a.ts')
    assert.strictEqual(relativePath('/etc/hosts', '/home/dev/repo'), '/etc/hosts')
    assert.strictEqual(relativePath('/home/dev/repo-other/a.ts', '/home/dev/repo'), '/home/dev/repo-other/a.ts')
  })
})
