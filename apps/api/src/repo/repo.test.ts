// Unit tests for the repository module's pure parts. Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAgent } from '@sdlc/core/discovery'
import {
  CreateGitConnectionInputSchema,
  CreateProjectInputSchema,
  fileWebUrl,
  isValidBranchName,
  isValidRepoPath,
  parseRepoUrl,
  pickConnection,
  RepositoryInputSchema,
  suggestProjectKey,
  suggestRepoName,
} from '@sdlc/contracts'
import { adaptersFor, assignSlugs } from './catalogImport'
import { CredentialCipher, tokenHint } from './credentials'
import { parseCatFileBatch, parseLsTree, redact } from './git'
import { gitignoreDir, IgnoreRules, looksSecret } from './ignoreRules'
import { decodeText, looksBinary } from './indexer'
import { assertHasRemote, gitBlobSha, parentDirs } from './workspace'

describe('parseRepoUrl', () => {
  const ok = (url: string) => {
    const r = parseRepoUrl(url)
    assert.ok(r.ok, `${url}: ${r.ok ? '' : r.error}`)
    return r.repo
  }

  it('accepts GitHub https and ssh forms and normalises them', () => {
    for (const url of ['https://github.com/acme/web', 'https://github.com/acme/web.git', 'https://github.com/acme/web/', 'git@github.com:acme/web.git', 'https://www.github.com/acme/web?tab=readme']) {
      const r = ok(url)
      assert.equal(r.provider, 'github')
      assert.equal(r.cloneUrl, 'https://github.com/acme/web.git')
      assert.equal(r.webUrl, 'https://github.com/acme/web')
      assert.equal(r.displayName, 'acme/web')
    }
  })

  it('accepts every Azure Repos form and normalises them to dev.azure.com', () => {
    for (const url of [
      'https://dev.azure.com/contoso/Payments/_git/api',
      'https://contoso@dev.azure.com/contoso/Payments/_git/api',
      'https://contoso.visualstudio.com/Payments/_git/api',
      'https://contoso.visualstudio.com/DefaultCollection/Payments/_git/api',
      'git@ssh.dev.azure.com:v3/contoso/Payments/api',
    ]) {
      const r = ok(url)
      assert.equal(r.provider, 'azure-repos')
      assert.equal(r.cloneUrl, 'https://dev.azure.com/contoso/Payments/_git/api')
      assert.equal(r.displayName, 'contoso/Payments/api')
    }
  })

  it('encodes Azure project names with spaces', () => {
    const r = ok('https://dev.azure.com/contoso/My%20Project/_git/api')
    assert.equal(r.project, 'My Project')
    assert.equal(r.cloneUrl, 'https://dev.azure.com/contoso/My%20Project/_git/api')
  })

  it('rejects credentials in the URL, other hosts, and file:// unless allowed', () => {
    const creds = parseRepoUrl('https://user:ghp_secret@github.com/acme/web')
    assert.ok(!creds.ok && /password/i.test(creds.error))
    assert.ok(!parseRepoUrl('https://gitlab.com/acme/web').ok)
    assert.ok(!parseRepoUrl('file:///tmp/repo.git').ok)
    const local = parseRepoUrl('file:///tmp/repo.git', { allowLocal: true })
    assert.ok(local.ok && local.repo.provider === 'local' && local.repo.repo === 'repo')
  })

  it('builds file links per provider', () => {
    const gh = ok('https://github.com/acme/web')
    assert.equal(fileWebUrl(gh, 'feature/x', 'src/a b.ts', 3), 'https://github.com/acme/web/blob/feature/x/src/a%20b.ts#L3')
    const az = ok('https://dev.azure.com/o/p/_git/r')
    assert.equal(fileWebUrl(az, 'main', 'src/a.ts'), 'https://dev.azure.com/o/p/_git/r?path=%2Fsrc%2Fa.ts&version=GBmain')
  })
})

describe('names and paths', () => {
  it('validates branch names like git', () => {
    for (const ok of ['main', 'feature/login', 'release-1.2', 'user/jo_e/fix']) assert.ok(isValidBranchName(ok), ok)
    for (const bad of ['', '-x', 'a..b', 'a b', 'a~1', 'x.lock', 'a//b', '/a', 'a/', '@', 'a@{1}', 'a/.hidden', 'a\\b', 'a:b']) assert.ok(!isValidBranchName(bad), bad)
  })

  it('validates repo paths', () => {
    assert.ok(isValidRepoPath('src/index.ts'))
    assert.ok(isValidRepoPath('', { allowRoot: true }))
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', 'dir/']) assert.ok(!isValidRepoPath(bad), bad)
  })

  it('suggests project keys from names', () => {
    assert.equal(suggestProjectKey('Payments Service'), 'PS')
    assert.equal(suggestProjectKey('restaurant'), 'RESTAU')
    assert.equal(suggestProjectKey('2024 Mobile App'), 'MA')
    assert.equal(suggestProjectKey('X'), 'XX')
    assert.equal(suggestProjectKey('!!!'), '')
  })
})

describe('IgnoreRules', () => {
  const rules = new IgnoreRules(
    new Map([
      ['', 'dist/\n*.log\n!keep.log\n/secret-dir\nbuild'],
      ['packages/app', 'generated/\n!important.log\n'],
    ]),
  )

  it('applies root rules, negation and folder rules', () => {
    assert.equal(rules.classify('dist/app.js'), 'ignored')
    assert.equal(rules.classify('src/dist/app.js'), 'ignored') // "dist/" matches at any depth
    assert.equal(rules.classify('debug.log'), 'ignored')
    assert.equal(rules.classify('keep.log'), 'keep')
    assert.equal(rules.classify('secret-dir/a.txt'), 'ignored')
    assert.equal(rules.classify('src/secret-dir/a.txt'), 'keep') // anchored to the root
    assert.equal(rules.classify('build'), 'ignored')
    assert.equal(rules.classify('src/index.ts'), 'keep')
  })

  it('applies nested .gitignore files relative to their folder, deeper ones winning', () => {
    assert.equal(rules.classify('packages/app/generated/x.ts'), 'ignored')
    assert.equal(rules.classify('packages/other/generated/x.ts'), 'keep')
    assert.equal(rules.classify('packages/app/important.log'), 'keep')
    assert.equal(rules.classify('packages/app/other.log'), 'ignored')
  })

  it('never keeps node_modules or .git, and cannot re-include inside an ignored folder', () => {
    assert.equal(rules.classify('node_modules/x/index.js'), 'ignored')
    assert.equal(rules.classify('a/node_modules/x.js'), 'ignored')
    const r = new IgnoreRules(new Map([['', 'logs/\n!logs/keep.txt']]))
    assert.equal(r.classify('logs/keep.txt'), 'ignored')
  })

  it('flags secrets without ignoring them', () => {
    const plain = new IgnoreRules(new Map())
    assert.equal(plain.classify('.env'), 'secret')
    assert.equal(plain.classify('config/.env.production'), 'secret')
    assert.equal(plain.classify('.env.example'), 'keep')
    assert.equal(plain.classify('certs/server.pem'), 'secret')
    assert.equal(plain.classify('.ssh/id_rsa'), 'secret')
    assert.equal(plain.classify('.ssh/id_rsa.pub'), 'keep')
    assert.ok(looksSecret('deploy/secrets.yaml'))
  })

  it('finds .gitignore folders', () => {
    assert.equal(gitignoreDir('.gitignore'), '')
    assert.equal(gitignoreDir('a/b/.gitignore'), 'a/b')
    assert.equal(gitignoreDir('a/b/x.gitignore'), null)
  })
})

describe('credentials', () => {
  it('round-trips and never contains the token', () => {
    const c = new CredentialCipher('test-key')
    const enc = c.encrypt('ghp_abcdefghijklmnop')
    assert.ok(!enc.includes('ghp_'))
    assert.equal(c.decrypt(enc), 'ghp_abcdefghijklmnop')
    assert.throws(() => new CredentialCipher('other-key').decrypt(enc))
    assert.equal(tokenHint('ghp_abcdefghijklmnop'), '…mnop')
  })

  it('redacts tokens and auth headers', () => {
    const auth = { provider: 'github' as const, token: 'ghp_SECRET123456' }
    const header = Buffer.from('x-access-token:ghp_SECRET123456').toString('base64')
    const out = redact(`fatal: ghp_SECRET123456 ${header} Authorization: Basic ${header} https://u:p@github.com/x`, auth)
    assert.ok(!out.includes('ghp_SECRET123456') && !out.includes(header) && !out.includes('u:p@'))
  })
})

describe('git output parsers', () => {
  it('parses ls-tree -r -l -z', () => {
    const buf = Buffer.from(
      '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa      12\tsrc/a b.ts\0' +
        '160000 commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb       -\tvendor/lib\0' +
        '120000 blob cccccccccccccccccccccccccccccccccccccccc       7\tlink\0',
    )
    const entries = parseLsTree(buf)
    assert.deepEqual(entries.map((e) => [e.path, e.type, e.size]), [
      ['src/a b.ts', 'blob', 12],
      ['vendor/lib', 'commit', 0],
      ['link', 'blob', 7],
    ])
  })

  it('parses cat-file --batch, including binary content and missing objects', () => {
    const bin = Buffer.from([0x00, 0x0a, 0xff])
    const buf = Buffer.concat([
      Buffer.from('aaaa blob 5\nhello\n'),
      Buffer.from('bbbb missing\n'),
      Buffer.from('cccc blob 3\n'),
      bin,
      Buffer.from('\n'),
    ])
    const map = parseCatFileBatch(buf)
    assert.equal(map.get('aaaa')?.toString(), 'hello')
    assert.ok(!map.has('bbbb'))
    assert.deepEqual([...(map.get('cccc') ?? [])], [...bin])
  })

  it('tells text from binary and keeps a BOM', () => {
    assert.ok(looksBinary(Buffer.from([0x41, 0x00])))
    assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41])), null)
    assert.equal(decodeText(Buffer.from('﻿hi', 'utf8')), '﻿hi')
  })
})

describe('catalog import', () => {
  const make = (name: string, sourceKind: 'claude-agent' | 'claude-skill', path: string) =>
    buildAgent({ sourceKind, sourcePath: path, raw: '', name, description: 'd', instructions: 'b', tools: [] })

  it('matches definition files to adapters', () => {
    assert.deepEqual(adaptersFor('.claude/agents/reviewer.md').map((a) => a.kind), ['claude-agent'])
    assert.deepEqual(adaptersFor('.claude/agents/qa/test-planner/AGENT.md').map((a) => a.kind), ['claude-agent'])
    assert.deepEqual(adaptersFor('.claude/skills/commit/SKILL.md').map((a) => a.kind), ['claude-skill'])
    assert.deepEqual(adaptersFor('packages/api/AGENTS.md').map((a) => a.kind), ['agents-md'])
    assert.deepEqual(adaptersFor('.github/agents/plan.agent.md').map((a) => a.kind), ['copilot-agent'])
    assert.deepEqual(adaptersFor('src/index.ts'), [])
  })

  it('reserves built-in slugs and separates a skill from an agent with the same name', () => {
    const rows = assignSlugs(
      [make('Planner', 'claude-agent', '.claude/agents/planner.md'), make('Review', 'claude-skill', '.claude/skills/review/SKILL.md'), make('Review', 'claude-agent', '.claude/agents/review.md')],
      new Set(['planner', 'reviewer']),
    )
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, `${r.agent.sourceKind}:${r.agent.name}`]))
    assert.deepEqual(bySlug, {
      'repo-planner': 'claude-agent:Planner',
      review: 'claude-agent:Review',
      'review-skill': 'claude-skill:Review',
    })
  })
})

describe('git connections', () => {
  const conns = [
    { id: 'gh-all', provider: 'github', owner: null },
    { id: 'gh-acme', provider: 'github', owner: 'Acme' },
    { id: 'az-contoso', provider: 'azure-repos', owner: 'contoso' },
  ]

  it('picks the most recently verified of several connections for the same organization', () => {
    const two = [
      { id: 'az-old', provider: 'azure-repos', owner: 'contoso', verifiedAt: '2026-01-01T00:00:00Z' },
      { id: 'az-new', provider: 'azure-repos', owner: 'Contoso', verifiedAt: new Date('2026-06-01T00:00:00Z') },
    ]
    assert.equal(pickConnection(two, 'azure-repos', 'contoso')?.id, 'az-new')
    assert.equal(pickConnection([...two].reverse(), 'azure-repos', 'contoso')?.id, 'az-new')
  })

  it('picks the owner-specific connection, case-insensitively', () => {
    assert.equal(pickConnection(conns, 'github', 'acme')?.id, 'gh-acme')
    assert.equal(pickConnection(conns, 'azure-repos', 'CONTOSO')?.id, 'az-contoso')
  })

  it('falls back to the all-owners GitHub connection, never across providers', () => {
    assert.equal(pickConnection(conns, 'github', 'someone-else')?.id, 'gh-all')
    assert.equal(pickConnection(conns, 'azure-repos', 'fabrikam'), null)
    assert.equal(pickConnection([], 'github', 'acme'), null)
  })

  it('requires an organization for Azure Repos and validates owners', () => {
    assert.ok(!CreateGitConnectionInputSchema.safeParse({ provider: 'azure-repos', token: 't' }).success)
    assert.ok(CreateGitConnectionInputSchema.safeParse({ provider: 'azure-repos', owner: 'contoso', token: 't' }).success)
    const all = CreateGitConnectionInputSchema.safeParse({ provider: 'github', owner: '', token: 't' })
    assert.ok(all.success && all.data.owner === undefined)
    assert.ok(!CreateGitConnectionInputSchema.safeParse({ provider: 'github', owner: 'https://github.com/acme', token: 't' }).success)
  })

  it('no longer accepts a token when linking a repository', () => {
    const parsed = RepositoryInputSchema.parse({ url: 'https://github.com/acme/web', token: 'ghp_x' })
    assert.ok(!('token' in parsed))
  })
})

describe('workspaces', () => {
  it('computes the same blob ids as git hash-object', () => {
    // `printf '' | git hash-object --stdin` and `printf 'hello\n' | git hash-object --stdin`
    assert.equal(gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
    assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a')
    // Multi-byte text is hashed by its UTF-8 bytes, not its length in characters.
    assert.equal(gitBlobSha('é'), gitBlobSha(Buffer.from('é', 'utf8').toString('utf8')))
    assert.notEqual(gitBlobSha('é'), gitBlobSha('e'))
  })

  it('lists the folders above a path', () => {
    assert.deepEqual(parentDirs('README.md'), [])
    assert.deepEqual(parentDirs('src/app/main.ts'), ['src', 'src/app'])
  })

  it('accepts a blank workspace or a repository, not both, and makes the key optional', () => {
    assert.ok(CreateProjectInputSchema.safeParse({ name: 'Payments', workspace: true }).success)
    const imported = CreateProjectInputSchema.safeParse({
      name: 'web',
      repository: { url: 'https://github.com/acme/web', connectionId: '6f1c2d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f' },
    })
    assert.ok(imported.success && imported.data.key === undefined && imported.data.repository?.connectionId)
    assert.ok(!CreateProjectInputSchema.safeParse({ name: 'x', workspace: true, repository: { url: 'https://github.com/acme/web' } }).success)
    assert.ok(!CreateProjectInputSchema.safeParse({ name: 'x', key: 'p' }).success)
  })

  it('suggests GitHub repository names from project names', () => {
    assert.equal(suggestRepoName('Payments Portal'), 'payments-portal')
    assert.equal(suggestRepoName('  Café  API v2 '), 'cafe-api-v2')
    assert.equal(suggestRepoName('???'), 'workspace')
  })

  it('never takes a workspace for a remote', () => {
    assert.ok(!parseRepoUrl('workspace://123').ok)
    assert.throws(() => assertHasRemote({ provider: 'workspace' }), /Publish it to GitHub/)
    assert.doesNotThrow(() => assertHasRemote({ provider: 'github' }))
  })
})
