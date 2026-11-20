// Workspaces: blank projects whose files live only in the platform's database (provider `workspace`, no remote).
// They reuse the linked-repository tables — one `main` branch, repo_files for the tree, repo_blobs for contents,
// repo_file_drafts for each member's edits — so the Code page works unchanged. A "commit" here writes the new
// contents straight into the tree; blob ids are real git blob ids, so publishing to GitHub later lines up.
// No git process and no job queue is ever involved.

import { createHash, randomBytes } from 'crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { type CommitConflict, type CommitInput, type CommitResult } from '@sdlc/contracts'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db, Tx } from '../db/client'
import { repoBlobs, repoBranches, repoFileDrafts, repoFiles } from '../db/schema'
import type { EventBus } from '../events'
import { badRequest, HttpError } from '../http'
import { looksSecret } from './ignoreRules'
import type { RepoRow } from './runtime'

export const WORKSPACE_BRANCH = 'main'

export function isWorkspace(repo: Pick<RepoRow, 'provider'>): boolean {
  return repo.provider === 'workspace'
}

/** 409 for anything that needs a remote (sync, branches, connection tests) on a workspace. */
export function assertHasRemote(repo: Pick<RepoRow, 'provider'>): void {
  if (isWorkspace(repo)) {
    throw new HttpError(409, 'workspace_no_remote', 'This workspace has no remote repository yet. Publish it to GitHub first.')
  }
}

/** The git blob id of a text file — `git hash-object` of its UTF-8 bytes. */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8')
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** Every folder above `path` ('a/b/c.ts' → ['a', 'a/b']). */
export function parentDirs(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** One change to the workspace: new contents, or null to delete the file. */
export interface WorkspaceChange {
  path: string
  content: string | null
}

type BranchRow = typeof repoBranches.$inferSelect

export async function workspaceBranch(db: Db | Tx, repo: RepoRow, name: string = WORKSPACE_BRANCH): Promise<BranchRow> {
  const [branch] = await db
    .select()
    .from(repoBranches)
    .where(and(eq(repoBranches.repositoryId, repo.id), eq(repoBranches.name, name)))
    .limit(1)
  if (!branch) throw new HttpError(409, 'branch_missing', `The workspace has no branch "${name}".`)
  return branch
}

/** Create the workspace's `main` branch (inside the project's creation transaction). */
export async function createWorkspaceBranch(tx: Tx, repositoryId: string): Promise<BranchRow> {
  const [branch] = await tx
    .insert(repoBranches)
    .values({ repositoryId, name: WORKSPACE_BRANCH, remoteSha: '0'.repeat(40), indexedSha: null, isDefault: true })
    .returning()
  return branch
}

/**
 * Apply changes to a workspace branch as one commit: store the blobs, update the tree (adding and pruning folder
 * rows), and move the branch to a new commit id. Returns that id. The caller audits and publishes.
 */
export async function writeWorkspaceFiles(
  tx: Tx,
  repo: RepoRow,
  branch: BranchRow,
  changes: WorkspaceChange[],
  author: string,
  message: string,
  maxFileBytes: number,
): Promise<string> {
  for (const c of changes) {
    if (c.content !== null && looksSecret(c.path)) {
      throw badRequest(`${c.path} looks like a secret (keys, .env files, credentials) — those can't be kept in a workspace.`)
    }
    if (c.content !== null && Buffer.byteLength(c.content, 'utf8') > maxFileBytes) {
      throw badRequest(`${c.path} is larger than the ${Math.round(maxFileBytes / 1024)} KB a workspace file can hold.`)
    }
  }

  for (const c of changes) {
    const existing = (
      await tx
        .select()
        .from(repoFiles)
        .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.path, c.path)))
        .limit(1)
    )[0]
    if (c.content === null) {
      if (!existing || existing.type !== 'file') throw badRequest(`There is no file ${c.path}.`)
      await tx.delete(repoFiles).where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.path, c.path)))
      continue
    }
    if (existing && existing.type === 'dir') throw badRequest(`${c.path} is a folder.`)
    // A file can't sit where a folder is needed.
    const parents = parentDirs(c.path)
    if (parents.length > 0) {
      const [blocker] = await tx
        .select({ path: repoFiles.path })
        .from(repoFiles)
        .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.type, 'file'), inArray(repoFiles.path, parents)))
        .limit(1)
      if (blocker) throw badRequest(`${blocker.path} is a file, so it can't hold ${c.path}.`)
    }

    const sha = gitBlobSha(c.content)
    const size = Buffer.byteLength(c.content, 'utf8')
    await tx.insert(repoBlobs).values({ repositoryId: repo.id, sha, size, content: c.content }).onConflictDoNothing()
    if (existing) {
      await tx.update(repoFiles).set({ blobSha: sha, size, status: 'stored' }).where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.path, c.path)))
    } else {
      await tx.insert(repoFiles).values({ branchId: branch.id, path: c.path, dir: dirOf(c.path), name: nameOf(c.path), type: 'file', mode: '100644', blobSha: sha, size, status: 'stored' })
    }
    for (const d of parentDirs(c.path)) {
      await tx
        .insert(repoFiles)
        .values({ branchId: branch.id, path: d, dir: dirOf(d), name: nameOf(d), type: 'dir', mode: '040000', blobSha: null, size: 0, status: null })
        .onConflictDoNothing()
    }
  }

  // Folders left empty by deletions go too (deepest first, so a chain of empty folders is removed).
  const deletedDirs = [...new Set(changes.filter((c) => c.content === null).flatMap((c) => parentDirs(c.path)))].sort((a, b) => b.length - a.length)
  for (const d of deletedDirs) {
    const [child] = await tx
      .select({ path: repoFiles.path })
      .from(repoFiles)
      .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.dir, d)))
      .limit(1)
    if (!child) await tx.delete(repoFiles).where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.path, d)))
  }

  const files = await tx
    .select({ path: repoFiles.path })
    .from(repoFiles)
    .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.type, 'file')))
  // A commit id for display and staleness checks — workspaces have no real git commits until they are published.
  const commit = createHash('sha1')
    .update(`${branch.indexedSha ?? ''}\n${changes.map((c) => c.path).join('\n')}\n${Date.now()}\n`)
    .update(randomBytes(8))
    .digest('hex')
  const now = new Date()
  await tx
    .update(repoBranches)
    .set({ remoteSha: commit, indexedSha: commit, indexedAt: now, commitMessage: message, commitAuthor: author, committedAt: now, fileCount: files.length })
    .where(eq(repoBranches.id, branch.id))
  return commit
}

interface CommitContext {
  db: Db
  bus: EventBus
  maxFileBytes: number
  project: { id: string; key: string; orgId: string }
  user: AuthUser
  via: string
}

function publishChange(ctx: CommitContext, branch: string): void {
  ctx.bus.publish({ type: 'repo.changed', projectKey: ctx.project.key, status: 'ready', branch, syncId: null, actorId: ctx.user.id })
}

async function auditCommit(tx: Tx, ctx: CommitContext, repo: RepoRow, branch: string, sha: string, paths: string[], message: string, action = 'code.committed'): Promise<void> {
  await writeAudit(tx, {
    orgId: ctx.project.orgId,
    projectId: ctx.project.id,
    actorUserId: ctx.user.id,
    action,
    resourceType: 'repository',
    resourceId: repo.id,
    data: { branch, sha, paths, message: message.split('\n')[0].slice(0, 200), workspace: true },
    via: ctx.via,
  })
}

/** Commit a member's drafts into a workspace — the same conflict rule as a remote commit, without git. */
export async function commitWorkspaceDrafts(ctx: CommitContext, repo: RepoRow, input: CommitInput): Promise<CommitResult> {
  const paths = [...new Set(input.paths)]
  const sha = await ctx.db.transaction(async (tx) => {
    const branch = await workspaceBranch(tx, repo, input.branch)
    const drafts = await tx
      .select()
      .from(repoFileDrafts)
      .where(
        and(
          eq(repoFileDrafts.repositoryId, repo.id),
          eq(repoFileDrafts.branch, input.branch),
          eq(repoFileDrafts.userId, ctx.user.id),
          inArray(repoFileDrafts.path, paths),
        ),
      )
    const missing = paths.filter((p) => !drafts.some((d) => d.path === p))
    if (missing.length > 0) throw badRequest(`You have no saved edit of ${missing.join(', ')} on ${input.branch}.`)

    const current = new Map(
      (
        await tx
          .select({ path: repoFiles.path, blobSha: repoFiles.blobSha })
          .from(repoFiles)
          .where(and(eq(repoFiles.branchId, branch.id), inArray(repoFiles.path, paths)))
      ).map((r) => [r.path, r.blobSha]),
    )
    const conflicts: CommitConflict[] = drafts
      .filter((d) => (current.get(d.path) ?? null) !== d.baseBlobSha)
      .map((d) => ({ path: d.path, remoteBlobSha: current.get(d.path) ?? null }))
    if (conflicts.length > 0) {
      throw new HttpError(
        409,
        'commit_conflict',
        conflicts.length === 1
          ? `${conflicts[0].path} changed on ${input.branch} since you started editing it.`
          : `${conflicts.length} files changed on ${input.branch} since you started editing them.`,
        { conflicts },
      )
    }
    if (drafts.every((d) => gitBlobSha(d.content) === d.baseBlobSha)) {
      throw badRequest('Your edits match what is already in the workspace — there is nothing to commit.')
    }

    const commit = await writeWorkspaceFiles(
      tx,
      repo,
      branch,
      drafts.map((d) => ({ path: d.path, content: d.content })),
      ctx.user.displayName,
      input.message,
      ctx.maxFileBytes,
    )
    await tx.delete(repoFileDrafts).where(inArray(repoFileDrafts.id, drafts.map((d) => d.id)))
    await auditCommit(tx, ctx, repo, input.branch, commit, paths, input.message)
    return commit
  })
  publishChange(ctx, input.branch)
  return { sha, branch: input.branch, paths, webUrl: null }
}

/** Add a file to a workspace (committed at once). */
export async function createWorkspaceFile(ctx: CommitContext, repo: RepoRow, input: { branch: string; path: string; content: string }): Promise<CommitResult> {
  const message = `Create ${input.path}`
  const sha = await ctx.db.transaction(async (tx) => {
    const branch = await workspaceBranch(tx, repo, input.branch)
    const [taken] = await tx
      .select({ type: repoFiles.type })
      .from(repoFiles)
      .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.path, input.path)))
      .limit(1)
    if (taken) throw new HttpError(409, 'path_exists', `${input.path} already exists.`)
    const commit = await writeWorkspaceFiles(tx, repo, branch, [{ path: input.path, content: input.content }], ctx.user.displayName, message, ctx.maxFileBytes)
    await auditCommit(tx, ctx, repo, input.branch, commit, [input.path], message, 'code.file_created')
    return commit
  })
  publishChange(ctx, input.branch)
  return { sha, branch: input.branch, paths: [input.path], webUrl: null }
}

/** Remove a file from a workspace (committed at once); everyone's drafts of it go too. */
export async function deleteWorkspaceFile(ctx: CommitContext, repo: RepoRow, input: { branch: string; path: string }): Promise<CommitResult> {
  const message = `Delete ${input.path}`
  const sha = await ctx.db.transaction(async (tx) => {
    const branch = await workspaceBranch(tx, repo, input.branch)
    const commit = await writeWorkspaceFiles(tx, repo, branch, [{ path: input.path, content: null }], ctx.user.displayName, message, ctx.maxFileBytes)
    await tx
      .delete(repoFileDrafts)
      .where(and(eq(repoFileDrafts.repositoryId, repo.id), eq(repoFileDrafts.branch, input.branch), eq(repoFileDrafts.path, input.path)))
    await auditCommit(tx, ctx, repo, input.branch, commit, [input.path], message, 'code.file_deleted')
    return commit
  })
  publishChange(ctx, input.branch)
  return { sha, branch: input.branch, paths: [input.path], webUrl: null }
}

/** Every stored file of a workspace branch with its contents — for publishing. */
export async function workspaceSnapshot(db: Db, repo: RepoRow, branch: BranchRow): Promise<Array<{ path: string; mode: string; content: string }>> {
  const rows = await db
    .select({ path: repoFiles.path, mode: repoFiles.mode, content: repoBlobs.content })
    .from(repoFiles)
    .innerJoin(repoBlobs, and(eq(repoBlobs.repositoryId, repo.id), eq(repoBlobs.sha, repoFiles.blobSha)))
    .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.type, 'file')))
  return rows
}
