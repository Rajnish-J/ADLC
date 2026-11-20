// Commit a member's drafts to a branch, and create branches — straight on the remote, with git plumbing in a temp
// bare repository (no checkout, nothing else written to disk):
//   fetch --depth 1 the branch tip → for every draft, is the file still the blob the edit started from?
//   (no → 409 with the conflicting paths, nothing pushed) → read-tree tip into a private index → hash-object the
//   new contents → update-index → write-tree → commit-tree (author = the platform user) → push (never forced).
// If the tip moved between fetch and push, the whole thing is retried once on the new tip.

import { and, eq, inArray } from 'drizzle-orm'
import { join } from 'path'
import { commitWebUrl, type CommitConflict, type CommitInput, type CommitResult } from '@sdlc/contracts'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import { repoBlobs, repoBranches, repoFileDrafts, repoFiles } from '../db/schema'
import { badRequest, HttpError } from '../http'
import { GitError, gitText, runGit, type GitOptions } from './git'
import type { RepoManager } from './jobs'
import { remoteOptionsFor } from './connections'
import { requireGit, withTempDir, type RepoRow } from './runtime'
import { assertHasRemote, commitWorkspaceDrafts, isWorkspace } from './workspace'

class TipMoved extends Error {}

async function fetchTip(url: string, branch: string, opts: GitOptions, dir: string): Promise<string> {
  await runGit(['init', '--bare', '-q', dir], { timeoutMs: 60_000 })
  try {
    await runGit(['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--quiet', url, `+refs/heads/${branch}:refs/sdlc/tip`], { ...opts, cwd: dir })
  } catch (err) {
    if (err instanceof GitError && /couldn't find remote ref/i.test(err.detail)) {
      throw new HttpError(409, 'branch_missing', `The branch "${branch}" no longer exists on the remote. Sync the repository.`)
    }
    throw err
  }
  return (await gitText(['rev-parse', '--verify', 'refs/sdlc/tip^{commit}'], { cwd: dir })).trim()
}

/** Blob ids of `paths` in `commit` (missing paths are absent from the map). */
async function blobsAt(dir: string, commit: string, paths: string[]): Promise<Map<string, string>> {
  const out = await gitText(['ls-tree', '-z', '--full-tree', commit, '--', ...paths], { cwd: dir })
  const map = new Map<string, string>()
  for (const rec of out.split('\0')) {
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const [, type, sha] = rec.slice(0, tab).split(/\s+/)
    if (type === 'blob') map.set(rec.slice(tab + 1), sha)
  }
  return map
}

function pushError(err: unknown): never {
  if (err instanceof GitError) {
    if (err.kind === 'rejected') throw new TipMoved()
    if (err.kind === 'protected' || err.kind === 'forbidden' || err.kind === 'auth') throw new HttpError(403, `push_${err.kind}`, err.message)
    throw new HttpError(502, 'push_failed', err.message)
  }
  throw err
}

export async function commitDrafts(
  manager: RepoManager,
  repo: RepoRow,
  project: { id: string; key: string; orgId: string },
  user: AuthUser,
  via: string,
  input: CommitInput,
): Promise<CommitResult> {
  const { rt } = manager
  const { db } = rt
  if (isWorkspace(repo)) {
    return commitWorkspaceDrafts({ db, bus: rt.bus, maxFileBytes: rt.maxFileBytes, project, user, via }, repo, input)
  }
  requireGit(rt)
  const paths = [...new Set(input.paths)]
  const drafts = await db
    .select()
    .from(repoFileDrafts)
    .where(
      and(
        eq(repoFileDrafts.repositoryId, repo.id),
        eq(repoFileDrafts.branch, input.branch),
        eq(repoFileDrafts.userId, user.id),
        inArray(repoFileDrafts.path, paths),
      ),
    )
  const missing = paths.filter((p) => !drafts.some((d) => d.path === p))
  if (missing.length > 0) throw badRequest(`You have no saved edit of ${missing.join(', ')} on ${input.branch}.`)

  const [branch] = await db
    .select()
    .from(repoBranches)
    .where(and(eq(repoBranches.repositoryId, repo.id), eq(repoBranches.name, input.branch)))
    .limit(1)
  if (!branch) throw new HttpError(409, 'branch_missing', `The branch "${input.branch}" is not on the remote any more. Sync the repository.`)
  const modes = new Map(
    (
      await db
        .select({ path: repoFiles.path, mode: repoFiles.mode })
        .from(repoFiles)
        .where(and(eq(repoFiles.branchId, branch.id), inArray(repoFiles.path, paths)))
    ).map((r) => [r.path, r.mode]),
  )

  const opts = await remoteOptionsFor(rt, repo)
  const attempt = (): Promise<{ sha: string; blobs: Map<string, string> }> =>
    withTempDir(rt, 'commit', async (dir) => {
      const tip = await fetchTip(repo.remoteUrl, input.branch, opts, dir)
      const atTip = await blobsAt(dir, tip, paths)
      const conflicts: CommitConflict[] = drafts
        .filter((d) => atTip.get(d.path) !== d.baseBlobSha)
        .map((d) => ({ path: d.path, remoteBlobSha: atTip.get(d.path) ?? null }))
      if (conflicts.length > 0) {
        // Re-index the branch so the newer version of those files shows up (and the drafts read as stale).
        await manager.enqueue(repo.id, 'commit', { branch: input.branch, requestedBy: user.id, via })
        throw new HttpError(
          409,
          'commit_conflict',
          conflicts.length === 1
            ? `${conflicts[0].path} changed on ${input.branch} since you started editing it.`
            : `${conflicts.length} files changed on ${input.branch} since you started editing them.`,
          { conflicts },
        )
      }

      const local = { cwd: dir, timeoutMs: 120_000, env: { GIT_INDEX_FILE: join(dir, 'sdlc-index') } }
      await runGit(['read-tree', tip], local)
      const blobs = new Map<string, string>()
      const indexInfo: string[] = []
      for (const d of drafts) {
        const sha = (await gitText(['hash-object', '-w', '--stdin'], { ...local, input: Buffer.from(d.content, 'utf8') })).trim()
        blobs.set(d.path, sha)
        const mode = modes.get(d.path) === '100755' ? '100755' : '100644'
        indexInfo.push(`${mode} ${sha}\t${d.path}`)
      }
      await runGit(['update-index', '-z', '--index-info'], { ...local, input: indexInfo.join('\0') + '\0' })
      const tree = (await gitText(['write-tree', '--missing-ok'], local)).trim()
      const tipTree = (await gitText(['rev-parse', `${tip}^{tree}`], local)).trim()
      if (tree === tipTree) throw badRequest('Your edits match what is already on the branch — there is nothing to commit.')

      const identity = {
        GIT_AUTHOR_NAME: user.displayName,
        GIT_AUTHOR_EMAIL: user.email,
        GIT_COMMITTER_NAME: user.displayName,
        GIT_COMMITTER_EMAIL: user.email,
      }
      const commit = (await gitText(['commit-tree', tree, '-p', tip, '-F', '-'], { ...local, env: { ...local.env, ...identity }, input: input.message + '\n' })).trim()
      try {
        await runGit(['push', '--quiet', '--no-verify', repo.remoteUrl, `${commit}:refs/heads/${input.branch}`], { ...opts, cwd: dir })
      } catch (err) {
        pushError(err)
      }
      return { sha: commit, blobs }
    })

  let result: { sha: string; blobs: Map<string, string> }
  try {
    result = await attempt()
  } catch (err) {
    if (!(err instanceof TipMoved)) throw err
    try {
      result = await attempt()
    } catch (again) {
      if (again instanceof TipMoved) throw new HttpError(409, 'branch_moving', `${input.branch} keeps changing on the remote. Try again in a moment.`)
      throw again
    }
  }

  // Show the committed version straight away; the re-index queued below reconciles anything else that moved.
  await db.transaction(async (tx) => {
    for (const d of drafts) {
      const blob = result.blobs.get(d.path)!
      const size = Buffer.byteLength(d.content, 'utf8')
      await tx.insert(repoBlobs).values({ repositoryId: repo.id, sha: blob, size, content: d.content }).onConflictDoNothing()
      await tx
        .update(repoFiles)
        .set({ blobSha: blob, size, status: 'stored' })
        .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.path, d.path)))
    }
    await tx.delete(repoFileDrafts).where(inArray(repoFileDrafts.id, drafts.map((d) => d.id)))
    await writeAudit(tx, {
      orgId: project.orgId,
      projectId: project.id,
      actorUserId: user.id,
      action: 'code.committed',
      resourceType: 'repository',
      resourceId: repo.id,
      data: { branch: input.branch, sha: result.sha, paths, message: input.message.split('\n')[0].slice(0, 200) },
      via,
    })
  })
  await manager.enqueue(repo.id, 'commit', { branch: input.branch, requestedBy: user.id, via })

  return { sha: result.sha, branch: input.branch, paths, webUrl: commitWebUrl(repo, result.sha) }
}

/**
 * Create `name` on the remote at the tip of `from`. The push carries a lease that the branch must not exist yet,
 * so an existing branch is never moved. The new branch is available at once: its files are copied from `from`.
 */
export async function createBranch(
  manager: RepoManager,
  repo: RepoRow,
  project: { id: string; orgId: string },
  user: AuthUser,
  via: string,
  input: { name: string; from: string },
): Promise<void> {
  const { rt } = manager
  const { db } = rt
  assertHasRemote(repo)
  const all = await db.select().from(repoBranches).where(eq(repoBranches.repositoryId, repo.id))
  if (all.some((b) => b.name === input.name)) throw new HttpError(409, 'branch_exists', `A branch named "${input.name}" already exists.`)
  const from = all.find((b) => b.name === input.from)
  if (!from) throw badRequest(`There is no branch "${input.from}".`)

  const opts = await remoteOptionsFor(rt, repo)
  const sha = await withTempDir(rt, 'branch', async (dir) => {
    const tip = await fetchTip(repo.remoteUrl, input.from, opts, dir)
    try {
      await runGit(['push', '--quiet', '--no-verify', `--force-with-lease=refs/heads/${input.name}:`, repo.remoteUrl, `${tip}:refs/heads/${input.name}`], {
        ...opts,
        cwd: dir,
      })
    } catch (err) {
      if (err instanceof GitError && err.kind === 'rejected') throw new HttpError(409, 'branch_exists', `A branch named "${input.name}" already exists on the remote.`)
      pushError(err)
    }
    return tip
  })

  await db.transaction(async (tx) => {
    const sameTip = from.indexedSha === sha
    const [created] = await tx
      .insert(repoBranches)
      .values({
        repositoryId: repo.id,
        name: input.name,
        remoteSha: sha,
        indexedSha: sameTip ? sha : null,
        indexedAt: sameTip ? new Date() : null,
        commitMessage: sameTip ? from.commitMessage : null,
        commitAuthor: sameTip ? from.commitAuthor : null,
        committedAt: sameTip ? from.committedAt : null,
        fileCount: sameTip ? from.fileCount : 0,
        ignoredCount: sameTip ? from.ignoredCount : 0,
      })
      .returning({ id: repoBranches.id })
    if (sameTip) {
      const files = await tx.select().from(repoFiles).where(eq(repoFiles.branchId, from.id))
      for (let i = 0; i < files.length; i += 1000) {
        await tx.insert(repoFiles).values(files.slice(i, i + 1000).map((f) => ({ ...f, branchId: created.id })))
      }
    }
    await writeAudit(tx, {
      orgId: project.orgId,
      projectId: project.id,
      actorUserId: user.id,
      action: 'code.branch_created',
      resourceType: 'repository',
      resourceId: repo.id,
      data: { branch: input.name, from: input.from, sha },
      via,
    })
  })
  if (from.indexedSha !== sha) await manager.enqueue(repo.id, 'branch', { branch: input.name, requestedBy: user.id, via })
  else await manager.publish(repo.id, input.name, null, user.id)
}
