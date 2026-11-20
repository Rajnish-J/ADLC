// Repository service: link / update / unlink a project's repository, test a connection, and read what the
// platform holds — branches, folders, files — plus each member's own drafts. Permission checks happen here.

import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import {
  can,
  fileWebUrl,
  isValidBranchName,
  parseRepoUrl,
  type DraftSummary,
  type FileDraft,
  type ProjectRepository,
  type RepoBranch,
  type RepoFile,
  type RepoPaths,
  type RepoSync,
  type RepoTestResult,
  type SaveDraftInput,
  type TreeEntry,
  type UpdateRepositoryInput,
} from '@sdlc/contracts'
import { assertCan, loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db } from '../db/client'
import { agents, projectRepositories, projects, repoBlobs, repoBranches, repoFileDrafts, repoFiles, repoSyncs, users, workflows } from '../db/schema'
import { badRequest, HttpError, notFound } from '../http'
import type { Caller } from '../services/context'
import { credentialForUrl, describeCredential, resolveRepoCredential } from './connections'
import { lsRemote, type GitAuth } from './git'
import type { RepoManager, SyncRow } from './jobs'
import { requireGit, type RepoRow, type RepoRuntime } from './runtime'
import { assertHasRemote, isWorkspace } from './workspace'

const PATHS_LIMIT = 20_000

// ─── Shapes ──────────────────────────────────────────────────────────────────────────────────────

async function toSync(db: Db, row: SyncRow): Promise<RepoSync> {
  let requestedBy: string | null = null
  if (row.requestedBy) {
    const [u] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, row.requestedBy)).limit(1)
    requestedBy = u?.name ?? null
  }
  return {
    id: row.id,
    trigger: row.trigger,
    branch: row.branch,
    status: row.status,
    stats: row.stats ?? null,
    error: row.error,
    requestedBy,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

export async function toRepository(db: Db, repo: RepoRow): Promise<ProjectRepository> {
  const [active] = await db
    .select()
    .from(repoSyncs)
    .where(and(eq(repoSyncs.repositoryId, repo.id), inArray(repoSyncs.status, ['queued', 'running'])))
    .orderBy(desc(repoSyncs.createdAt))
    .limit(1)
  return {
    id: repo.id,
    provider: repo.provider,
    remoteUrl: repo.remoteUrl,
    webUrl: repo.webUrl,
    displayName: repo.displayName,
    defaultBranch: repo.defaultBranch,
    status: repo.status,
    hasToken: repo.credentialEnc !== null,
    tokenHint: repo.credentialHint,
    credential: await describeCredential(db, repo),
    lastSyncedAt: repo.lastSyncedAt?.toISOString() ?? null,
    lastError: repo.lastError,
    activeSync: active ? await toSync(db, active) : null,
    createdAt: repo.createdAt.toISOString(),
    updatedAt: repo.updatedAt.toISOString(),
  }
}

// ─── Loading ─────────────────────────────────────────────────────────────────────────────────────

async function repoOf(db: Db, projectId: string): Promise<RepoRow | undefined> {
  const [repo] = await db.select().from(projectRepositories).where(eq(projectRepositories.projectId, projectId)).limit(1)
  return repo
}

async function requireRepo(db: Db, access: ProjectAccess): Promise<RepoRow> {
  const repo = await repoOf(db, access.project.id)
  if (!repo) throw new HttpError(404, 'no_repository', 'This project has no linked repository.')
  return repo
}

/** The branch to read: the named one, or the default. It must exist, and its files must be indexed. */
async function indexedBranch(db: Db, repo: RepoRow, name: string | undefined) {
  const branchName = name || repo.defaultBranch
  if (!branchName) throw new HttpError(409, 'repository_empty', 'The repository has no branches yet.')
  if (!isValidBranchName(branchName)) throw badRequest('Not a valid branch name.')
  const [branch] = await db
    .select()
    .from(repoBranches)
    .where(and(eq(repoBranches.repositoryId, repo.id), eq(repoBranches.name, branchName)))
    .limit(1)
  if (!branch) throw notFound(`Branch "${branchName}"`)
  if (!branch.indexedSha) {
    throw new HttpError(409, 'branch_not_indexed', `The branch "${branchName}" hasn't been opened yet — open it to load its files.`)
  }
  return branch
}

// ─── Link / test / unlink ────────────────────────────────────────────────────────────────────────

/** ls-remote a URL with the given credential and summarise what is there. */
async function probe(cloneUrl: string, auth: GitAuth): Promise<{ defaultBranch: string | null; branchCount: number }> {
  try {
    const remote = await lsRemote(cloneUrl, { auth, timeoutMs: 60_000, allowFileProtocol: auth.provider === 'local' })
    return { defaultBranch: remote.head && remote.branches.has(remote.head) ? remote.head : null, branchCount: remote.branches.size }
  } catch (err) {
    throw new HttpError(422, 'connection_failed', err instanceof Error ? err.message : 'Could not reach the repository.')
  }
}

/**
 * Check a repository URL before a project exists, with the organisation's matching Git connection (or none, for
 * a public repository). Nothing is saved.
 */
export async function testConnection(rt: RepoRuntime, user: AuthUser, input: { url: string }): Promise<RepoTestResult> {
  requireGit(rt)
  const parsed = parseRepoUrl(input.url, { allowLocal: rt.allowLocal })
  if (!parsed.ok) throw badRequest(parsed.error)
  const owner = parsed.repo.provider === 'local' ? null : parsed.repo.owner
  const { auth, credential } = await credentialForUrl(rt, user.orgId, parsed.repo.provider, owner)
  const found = await probe(parsed.repo.cloneUrl, auth)
  return { provider: parsed.repo.provider, displayName: parsed.repo.displayName, ...found, credential }
}

/** The same check for an existing project (its own older token, if it still has one, is used first). */
export async function testProjectConnection(rt: RepoRuntime, caller: Caller, key: string, input: { url: string }): Promise<RepoTestResult> {
  const access = await loadProjectAccess(rt.db, caller.user, key)
  assertCan(access, 'repo.manage')
  const parsed = parseRepoUrl(input.url, { allowLocal: rt.allowLocal })
  if (!parsed.ok) throw badRequest(parsed.error)
  const repo = await repoOf(rt.db, access.project.id)
  if (repo && repo.remoteUrl === parsed.repo.cloneUrl) {
    requireGit(rt)
    const { auth, credential } = await resolveRepoCredential(rt, repo)
    const found = await probe(parsed.repo.cloneUrl, auth)
    return { provider: parsed.repo.provider, displayName: parsed.repo.displayName, ...found, credential }
  }
  return testConnection(rt, caller.user, input)
}

/** Values for a new project_repositories row (validated URL). Access comes from the Git connections. */
export function newRepositoryValues(
  rt: RepoRuntime,
  projectId: string,
  createdBy: string,
  input: { url: string; defaultBranch?: string | null; connectionId?: string | null },
): typeof projectRepositories.$inferInsert {
  const parsed = parseRepoUrl(input.url, { allowLocal: rt.allowLocal })
  if (!parsed.ok) throw badRequest(parsed.error)
  const branch = input.defaultBranch?.trim() || null
  if (branch && !isValidBranchName(branch)) throw badRequest('Not a valid branch name.')
  return {
    projectId,
    provider: parsed.repo.provider,
    remoteUrl: parsed.repo.cloneUrl,
    webUrl: parsed.repo.webUrl,
    displayName: parsed.repo.displayName,
    defaultBranch: branch,
    defaultBranchPinned: branch !== null,
    credentialEnc: null,
    credentialHint: null,
    connectionId: input.connectionId ?? null,
    status: 'queued',
    createdBy,
  }
}

export async function getRepository(db: Db, user: AuthUser, key: string): Promise<ProjectRepository | null> {
  const access = await loadProjectAccess(db, user, key)
  const repo = await repoOf(db, access.project.id)
  return repo ? toRepository(db, repo) : null
}

/**
 * Link a repository, or change the linked one. A new URL starts over (the old copy, branches and drafts go);
 * a new default branch keeps the copy and re-syncs. `token: null` drops an older project-level token so the
 * repository uses the Git connections.
 */
export async function saveRepository(manager: RepoManager, caller: Caller, key: string, input: UpdateRepositoryInput): Promise<ProjectRepository> {
  const { rt } = manager
  const { db } = rt
  requireGit(rt)
  const access = await loadProjectAccess(db, caller.user, key)
  assertCan(access, 'repo.manage')
  const existing = await repoOf(db, access.project.id)
  if (existing && isWorkspace(existing)) {
    throw new HttpError(409, 'workspace_exists', 'This project is a workspace. Publish it to GitHub instead, or delete the workspace first.')
  }
  const parsed = parseRepoUrl(input.url, { allowLocal: rt.allowLocal })
  if (!parsed.ok) throw badRequest(parsed.error)

  const sameRemote = existing && existing.remoteUrl === parsed.repo.cloneUrl
  const repo = await db.transaction(async (tx) => {
    let row: RepoRow
    if (existing && sameRemote) {
      const patch: Partial<typeof projectRepositories.$inferInsert> = { updatedAt: new Date() }
      if (input.token === null) {
        patch.credentialEnc = null
        patch.credentialHint = null
      }
      if (input.defaultBranch !== undefined) {
        const b = input.defaultBranch?.trim() || null
        if (b && !isValidBranchName(b)) throw badRequest('Not a valid branch name.')
        patch.defaultBranch = b ?? existing.defaultBranch
        patch.defaultBranchPinned = b !== null
      }
      ;[row] = await tx.update(projectRepositories).set(patch).where(eq(projectRepositories.id, existing.id)).returning()
    } else {
      if (existing) await tx.delete(projectRepositories).where(eq(projectRepositories.id, existing.id))
      ;[row] = await tx
        .insert(projectRepositories)
        .values(newRepositoryValues(rt, access.project.id, caller.user.id, { url: input.url, defaultBranch: input.defaultBranch }))
        .returning()
    }
    await tx.update(projects).set({ repoUrl: row.remoteUrl }).where(eq(projects.id, access.project.id))
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: existing ? 'repo.updated' : 'repo.linked',
      resourceType: 'repository',
      resourceId: row.id,
      data: {
        repository: row.displayName,
        provider: row.provider,
        ...(existing && !sameRemote ? { previous: existing.displayName } : {}),
        ...(input.token === null && existing?.credentialEnc ? { token: 'removed' } : {}),
      },
      via: caller.via,
    })
    return row
  })
  await manager.enqueue(repo.id, existing && sameRemote ? 'manual' : 'link', { requestedBy: caller.user.id, via: caller.via })
  manager.rt.bus.publish({ type: 'project.changed', projectKey: access.project.key, action: 'repository', actorId: caller.user.id })
  const [fresh] = await db.select().from(projectRepositories).where(eq(projectRepositories.id, repo.id)).limit(1)
  return toRepository(db, fresh)
}

/** Disconnect the repository: its copy, branches, drafts and history go; repo agents go unless a workflow uses one. */
export async function unlinkRepository(manager: RepoManager, caller: Caller, key: string): Promise<void> {
  const { db } = manager.rt
  const access = await loadProjectAccess(db, caller.user, key)
  assertCan(access, 'repo.manage')
  const repo = await requireRepo(db, access)
  const projectWorkflows = await db.select({ spec: workflows.spec }).from(workflows).where(eq(workflows.projectId, access.project.id))
  const used = new Set(projectWorkflows.flatMap((w) => w.spec.nodes.filter((n) => n.kind === 'agent').map((n) => String(n.data.agentId ?? ''))))
  await db.transaction(async (tx) => {
    const repoAgents = await tx.select().from(agents).where(and(eq(agents.projectId, access.project.id), eq(agents.source, 'repo')))
    const removable = repoAgents.filter((a) => !used.has(a.slug)).map((a) => a.id)
    if (removable.length > 0) await tx.delete(agents).where(inArray(agents.id, removable))
    await tx.delete(projectRepositories).where(eq(projectRepositories.id, repo.id))
    await tx.update(projects).set({ repoUrl: null }).where(eq(projects.id, access.project.id))
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'repo.unlinked',
      resourceType: 'repository',
      resourceId: repo.id,
      data: { repository: repo.displayName, agentsRemoved: removable.length },
      via: caller.via,
    })
  })
  manager.rt.bus.publish({ type: 'project.changed', projectKey: access.project.key, action: 'repository', actorId: caller.user.id })
  manager.rt.bus.publish({ type: 'project.changed', projectKey: access.project.key, action: 'agents', actorId: caller.user.id })
}

export async function requestSync(manager: RepoManager, caller: Caller, key: string): Promise<RepoSync> {
  requireGit(manager.rt)
  const access = await loadProjectAccess(manager.rt.db, caller.user, key)
  assertCan(access, 'code.edit')
  const repo = await requireRepo(manager.rt.db, access)
  assertHasRemote(repo)
  return toSync(manager.rt.db, await manager.enqueue(repo.id, 'manual', { requestedBy: caller.user.id, via: caller.via }))
}

export async function listSyncs(db: Db, user: AuthUser, key: string): Promise<RepoSync[]> {
  const access = await loadProjectAccess(db, user, key)
  const repo = await requireRepo(db, access)
  const rows = await db.select().from(repoSyncs).where(eq(repoSyncs.repositoryId, repo.id)).orderBy(desc(repoSyncs.createdAt)).limit(30)
  return Promise.all(rows.map((r) => toSync(db, r)))
}

// ─── Branches ────────────────────────────────────────────────────────────────────────────────────

export async function listBranches(db: Db, user: AuthUser, key: string): Promise<RepoBranch[]> {
  const access = await loadProjectAccess(db, user, key)
  const repo = await requireRepo(db, access)
  const rows = await db.select().from(repoBranches).where(eq(repoBranches.repositoryId, repo.id)).orderBy(desc(repoBranches.isDefault), asc(repoBranches.name))
  const busy = await db
    .select({ branch: repoSyncs.branch })
    .from(repoSyncs)
    .where(and(eq(repoSyncs.repositoryId, repo.id), inArray(repoSyncs.status, ['queued', 'running'])))
  const fullSync = busy.some((b) => b.branch === null)
  const busyBranches = new Set(busy.map((b) => b.branch))
  const drafts = await db
    .select({ branch: repoFileDrafts.branch, n: count() })
    .from(repoFileDrafts)
    .where(and(eq(repoFileDrafts.repositoryId, repo.id), eq(repoFileDrafts.userId, user.id)))
    .groupBy(repoFileDrafts.branch)
  const draftCounts = new Map(drafts.map((d) => [d.branch, d.n]))
  return rows.map((b) => ({
    name: b.name,
    isDefault: b.isDefault,
    remoteSha: b.remoteSha,
    indexedSha: b.indexedSha,
    indexedAt: b.indexedAt?.toISOString() ?? null,
    indexing: busyBranches.has(b.name) || (fullSync && (b.isDefault || b.indexedSha !== null)),
    commit: b.indexedSha
      ? { sha: b.indexedSha, message: b.commitMessage ?? '', author: b.commitAuthor ?? '', committedAt: b.committedAt?.toISOString() ?? null }
      : null,
    fileCount: b.fileCount,
    ignoredCount: b.ignoredCount,
    myDraftCount: draftCounts.get(b.name) ?? 0,
  }))
}

/** Load a branch's files (anyone who can see the project may open a branch). */
export async function requestBranchIndex(manager: RepoManager, caller: Caller, key: string, branchName: string): Promise<RepoSync | null> {
  requireGit(manager.rt)
  const { db } = manager.rt
  const access = await loadProjectAccess(db, caller.user, key)
  const repo = await requireRepo(db, access)
  if (isWorkspace(repo)) return null
  if (!isValidBranchName(branchName)) throw badRequest('Not a valid branch name.')
  const [branch] = await db
    .select()
    .from(repoBranches)
    .where(and(eq(repoBranches.repositoryId, repo.id), eq(repoBranches.name, branchName)))
    .limit(1)
  if (!branch) throw notFound(`Branch "${branchName}"`)
  if (branch.indexedSha && branch.indexedSha === branch.remoteSha) return null
  return toSync(db, await manager.enqueue(repo.id, 'branch', { branch: branchName, requestedBy: caller.user.id, via: caller.via }))
}

// ─── Tree & files ────────────────────────────────────────────────────────────────────────────────

async function myDraftPaths(db: Db, repo: RepoRow, branch: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ path: repoFileDrafts.path })
    .from(repoFileDrafts)
    .where(and(eq(repoFileDrafts.repositoryId, repo.id), eq(repoFileDrafts.branch, branch), eq(repoFileDrafts.userId, userId)))
  return rows.map((r) => r.path)
}

/** One folder's entries: folders first, then files, by name. */
export async function listTree(db: Db, user: AuthUser, key: string, branchName: string | undefined, dir: string): Promise<TreeEntry[]> {
  const access = await loadProjectAccess(db, user, key)
  const repo = await requireRepo(db, access)
  const branch = await indexedBranch(db, repo, branchName)
  const rows = await db
    .select()
    .from(repoFiles)
    .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.dir, dir)))
  const drafts = await myDraftPaths(db, repo, branch.name, user.id)
  return rows
    .map((r) => ({
      path: r.path,
      name: r.name,
      type: r.type,
      size: r.size,
      status: r.status,
      hasDraft: r.type === 'file' ? drafts.includes(r.path) : drafts.some((p) => p.startsWith(`${r.path}/`)),
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1))
}

/** Every file path on the branch, for quick open (capped). */
export async function listPaths(db: Db, user: AuthUser, key: string, branchName: string | undefined): Promise<RepoPaths> {
  const access = await loadProjectAccess(db, user, key)
  const repo = await requireRepo(db, access)
  const branch = await indexedBranch(db, repo, branchName)
  const rows = await db
    .select({ path: repoFiles.path })
    .from(repoFiles)
    .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.type, 'file')))
    .orderBy(asc(repoFiles.path))
    .limit(PATHS_LIMIT + 1)
  return { paths: rows.slice(0, PATHS_LIMIT).map((r) => r.path), truncated: rows.length > PATHS_LIMIT }
}

function toDraft(row: typeof repoFileDrafts.$inferSelect, currentBlob: string | null): FileDraft {
  return {
    branch: row.branch,
    path: row.path,
    baseBlobSha: row.baseBlobSha,
    content: row.content,
    updatedAt: row.updatedAt.toISOString(),
    stale: currentBlob !== null && currentBlob !== row.baseBlobSha,
  }
}

export async function getFile(db: Db, user: AuthUser, key: string, branchName: string | undefined, path: string): Promise<RepoFile> {
  const access = await loadProjectAccess(db, user, key)
  const repo = await requireRepo(db, access)
  const branch = await indexedBranch(db, repo, branchName)
  const [file] = await db
    .select()
    .from(repoFiles)
    .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.path, path), eq(repoFiles.type, 'file')))
    .limit(1)
  if (!file || !file.blobSha || !file.status) throw notFound('File')
  let content: string | null = null
  if (file.status === 'stored') {
    const [blob] = await db
      .select({ content: repoBlobs.content })
      .from(repoBlobs)
      .where(and(eq(repoBlobs.repositoryId, repo.id), eq(repoBlobs.sha, file.blobSha)))
      .limit(1)
    content = blob?.content ?? null
  }
  const [draft] = await db
    .select()
    .from(repoFileDrafts)
    .where(
      and(
        eq(repoFileDrafts.repositoryId, repo.id),
        eq(repoFileDrafts.branch, branch.name),
        eq(repoFileDrafts.path, path),
        eq(repoFileDrafts.userId, user.id),
      ),
    )
    .limit(1)
  const canEdit = can(access.actor, access.role, 'code.edit')
  return {
    branch: branch.name,
    path: file.path,
    blobSha: file.blobSha,
    size: file.size,
    mode: file.mode,
    status: file.status,
    content,
    editable: file.status === 'stored' && content !== null && canEdit,
    draft: draft ? toDraft(draft, file.blobSha) : null,
    webUrl: fileWebUrl(repo, branch.name, file.path),
  }
}

/** Content of one blob by id (e.g. the version a draft started from), scoped to the project's repository. */
export async function getBlob(db: Db, user: AuthUser, key: string, sha: string): Promise<{ sha: string; content: string }> {
  const access = await loadProjectAccess(db, user, key)
  const repo = await requireRepo(db, access)
  const [blob] = await db
    .select({ content: repoBlobs.content })
    .from(repoBlobs)
    .where(and(eq(repoBlobs.repositoryId, repo.id), eq(repoBlobs.sha, sha)))
    .limit(1)
  if (!blob) throw notFound('File version')
  return { sha, content: blob.content }
}

// ─── Drafts (each member's own) ──────────────────────────────────────────────────────────────────

export async function listDrafts(db: Db, user: AuthUser, key: string, branchName: string | undefined): Promise<DraftSummary[]> {
  const access = await loadProjectAccess(db, user, key)
  assertCan(access, 'code.edit')
  const repo = await requireRepo(db, access)
  const where = [eq(repoFileDrafts.repositoryId, repo.id), eq(repoFileDrafts.userId, user.id)]
  if (branchName) where.push(eq(repoFileDrafts.branch, branchName))
  const rows = await db.select().from(repoFileDrafts).where(and(...where)).orderBy(asc(repoFileDrafts.branch), asc(repoFileDrafts.path))
  // Current blob of each draft's file, to flag stale ones.
  const branches = await db.select().from(repoBranches).where(eq(repoBranches.repositoryId, repo.id))
  const out: DraftSummary[] = []
  for (const d of rows) {
    const b = branches.find((x) => x.name === d.branch)
    let current: string | null = null
    if (b) {
      const [f] = await db
        .select({ blobSha: repoFiles.blobSha })
        .from(repoFiles)
        .where(and(eq(repoFiles.branchId, b.id), eq(repoFiles.path, d.path)))
        .limit(1)
      current = f?.blobSha ?? null
    }
    const { content: _content, ...summary } = toDraft(d, current)
    out.push(summary)
  }
  return out
}

export async function saveDraft(db: Db, caller: Caller, key: string, input: SaveDraftInput): Promise<FileDraft> {
  const access = await loadProjectAccess(db, caller.user, key)
  assertCan(access, 'code.edit')
  const repo = await requireRepo(db, access)
  const branch = await indexedBranch(db, repo, input.branch)
  const [file] = await db
    .select()
    .from(repoFiles)
    .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.path, input.path), eq(repoFiles.type, 'file')))
    .limit(1)
  if (!file) throw notFound('File')
  if (file.status !== 'stored') throw badRequest('Only text files the platform stores can be edited.')
  // The base must be a version of this file the platform knows: the current one, or the one an earlier draft
  // started from (a draft kept across a re-sync), or — after a conflict — the newer remote version.
  if (input.baseBlobSha !== file.blobSha) {
    const [known] = await db
      .select({ sha: repoBlobs.sha })
      .from(repoBlobs)
      .where(and(eq(repoBlobs.repositoryId, repo.id), eq(repoBlobs.sha, input.baseBlobSha)))
      .limit(1)
    if (!known) throw badRequest('The edit is based on a version of the file the platform does not have. Reload the file.')
  }
  const now = new Date()
  const [row] = await db
    .insert(repoFileDrafts)
    .values({ repositoryId: repo.id, branch: branch.name, path: input.path, userId: caller.user.id, baseBlobSha: input.baseBlobSha, content: input.content, updatedAt: now })
    .onConflictDoUpdate({
      target: [repoFileDrafts.repositoryId, repoFileDrafts.branch, repoFileDrafts.path, repoFileDrafts.userId],
      set: { content: input.content, baseBlobSha: input.baseBlobSha, updatedAt: now },
    })
    .returning()
  return toDraft(row, file.blobSha)
}

export async function discardDraft(db: Db, caller: Caller, key: string, branch: string, path: string): Promise<void> {
  const access = await loadProjectAccess(db, caller.user, key)
  assertCan(access, 'code.edit')
  const repo = await requireRepo(db, access)
  await db
    .delete(repoFileDrafts)
    .where(
      and(
        eq(repoFileDrafts.repositoryId, repo.id),
        eq(repoFileDrafts.branch, branch),
        eq(repoFileDrafts.path, path),
        eq(repoFileDrafts.userId, caller.user.id),
      ),
    )
}

export { repoOf, requireRepo }
