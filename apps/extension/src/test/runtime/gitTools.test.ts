// Git commit/push + PR-creation agent tools — governance gating and the safety-critical refusal
// paths (never stage outside the tracked change set, never push directly to the target branch).

import * as assert from 'assert'
import * as vscode from 'vscode'
import { mapAgentToolsToGitTools } from '../../runtime/dispatch/toolGating'
import { buildGitTools, type GitToolConfig } from '../../runtime/dispatch/gitTools'
import type { Repository } from '../../@types/git'

function fakeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    rootUri: vscode.Uri.file('/repo'),
    state: {
      HEAD: undefined,
      remotes: [],
      workingTreeChanges: [],
      indexChanges: [],
      untrackedChanges: [],
      onDidChange: (() => new vscode.Disposable(() => {})) as unknown as Repository['state']['onDidChange'],
    },
    add: async () => {},
    createBranch: async () => {},
    checkout: async () => {},
    getBranch: async () => ({ name: 'test' }) as Awaited<ReturnType<Repository['getBranch']>>,
    commit: async () => {},
    push: async () => {},
    status: async () => {},
    ...overrides,
  }
}

function gitConfig(overrides: Partial<GitToolConfig> = {}): GitToolConfig {
  return {
    getRepository: async () => fakeRepo(),
    changedPaths: new Set(['src/a.ts']),
    targetBranch: 'main',
    createDraftPRs: true,
    ...overrides,
  }
}

suite('Git tool gating', () => {
  test('read (git_status) is always granted; writes require declaration + kill-switch on', () => {
    let perm = mapAgentToolsToGitTools(undefined, true)
    assert.strictEqual(perm.read, true)
    assert.strictEqual(perm.write.size, 0)

    // Declares a write tool but kill-switch off → still no writes.
    perm = mapAgentToolsToGitTools(['create_pull_request'], false)
    assert.strictEqual(perm.write.size, 0)

    // Declares a write tool and kill-switch on → that write granted.
    perm = mapAgentToolsToGitTools(['create_pull_request'], true)
    assert.ok(perm.write.has('create_pull_request'))
    assert.ok(!perm.write.has('git_commit_and_push'))

    // An alias resolves to the same canonical tool.
    perm = mapAgentToolsToGitTools(['git_push'], true)
    assert.ok(perm.write.has('git_commit_and_push'))

    // A "git" group capability grants all writes (when enabled).
    perm = mapAgentToolsToGitTools(['git'], true)
    assert.ok(perm.write.has('git_commit_and_push'))
    assert.ok(perm.write.has('create_pull_request'))
  })
})

suite('Git tools — buildGitTools', () => {
  test('offers no tools when no git repo is configured for the run', () => {
    const { defs } = buildGitTools({ read: true, write: new Set(['git_commit_and_push']) }, undefined)
    assert.strictEqual(defs.length, 0)
  })

  test('offers git_status and only the granted write tools', () => {
    const { defs } = buildGitTools({ read: true, write: new Set(['git_commit_and_push']) }, gitConfig())
    const names = defs.map((d) => d.name)
    assert.ok(names.includes('git_status'))
    assert.ok(names.includes('git_commit_and_push'))
    assert.ok(!names.includes('create_pull_request'))
  })

  test('invoke refuses a tool that was not offered', async () => {
    const { invoke } = buildGitTools({ read: true, write: new Set() }, gitConfig())
    const out = await invoke('git_commit_and_push', { message: 'msg' }, {} as never)
    assert.match(out, /not permitted/)
  })

  test('git_commit_and_push refuses when nothing was written this run', async () => {
    const config = gitConfig({ changedPaths: new Set() })
    const { invoke } = buildGitTools({ read: true, write: new Set(['git_commit_and_push']) }, config)
    const out = await invoke('git_commit_and_push', { message: 'msg' }, {} as never)
    assert.match(out, /[Nn]othing to commit/)
  })

  test('git_commit_and_push refuses to push directly to the target branch', async () => {
    const config = gitConfig({ targetBranch: 'main' })
    const { invoke } = buildGitTools({ read: true, write: new Set(['git_commit_and_push']) }, config)
    const out = await invoke('git_commit_and_push', { message: 'msg', branch: 'main' }, {} as never)
    assert.match(out, /[Rr]efusing to push/)
  })

  test('git_commit_and_push stages only the files this run wrote, resolved to absolute paths', async () => {
    // Repository.add() takes absolute filesystem paths, not workspace-relative ones — verify the
    // relative paths tracked from write_file/replace_in_file get resolved against repo.rootUri
    // before being staged (and that only those two files are staged, never the whole tree).
    const addedPaths: string[][] = []
    const repo = fakeRepo({ add: async (paths) => void addedPaths.push(paths) })
    const config = gitConfig({ getRepository: async () => repo, changedPaths: new Set(['src/a.ts', 'src/b.ts']) })
    const { invoke } = buildGitTools({ read: true, write: new Set(['git_commit_and_push']) }, config)
    const out = await invoke('git_commit_and_push', { message: 'msg', branch: 'feature/x' }, {} as never)
    assert.match(out, /Pushed 2 file/)
    assert.strictEqual(addedPaths.length, 1)
    const expected = [
      vscode.Uri.joinPath(repo.rootUri, 'src/a.ts').fsPath,
      vscode.Uri.joinPath(repo.rootUri, 'src/b.ts').fsPath,
    ].sort()
    assert.deepStrictEqual([...addedPaths[0]].sort(), expected)
  })

  test('create_pull_request requires Azure DevOps context', async () => {
    const config = gitConfig({ ado: undefined })
    const { invoke } = buildGitTools({ read: true, write: new Set(['create_pull_request']) }, config)
    const out = await invoke('create_pull_request', { title: 'My PR', sourceBranch: 'feature/x' }, {} as never)
    assert.match(out, /Azure DevOps is not configured/)
  })

  test('create_pull_request defaults sourceBranch to the branch git_commit_and_push just pushed', async () => {
    let requestedBody: Record<string, unknown> = {}
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body ?? '{}'))
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ pullRequestId: 7 }),
      } as Response
    }) as typeof fetch
    try {
      const config = gitConfig({
        ado: { org: 'o', project: 'p', repository: 'r', getToken: async () => 'tok', workItemId: 1 },
      })
      const { invoke } = buildGitTools(
        { read: true, write: new Set(['git_commit_and_push', 'create_pull_request']) },
        config,
      )
      const pushOut = await invoke('git_commit_and_push', { message: 'msg', branch: 'feature/y' }, {} as never)
      assert.match(pushOut, /feature\/y/)
      const prOut = await invoke('create_pull_request', { title: 'My PR' }, {} as never)
      assert.match(prOut, /Opened pull request #7/)
      assert.strictEqual(requestedBody.sourceRefName, 'refs/heads/feature/y')
      assert.strictEqual(requestedBody.targetRefName, 'refs/heads/main')
      assert.deepStrictEqual(requestedBody.workItemRefs, [{ id: '1' }])
    } finally {
      globalThis.fetch = original
    }
  })
})
