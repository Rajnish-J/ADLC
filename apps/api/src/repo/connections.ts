// Git connections: the organisation's access tokens for GitHub and Azure Repos, managed by org admins on one page.
// Every clone, sync, commit and branch creation resolves its credential here, at the moment it runs:
//   1. a token stored on the project itself (repositories linked before connections existed), else
//   2. the connection the repository was imported or published with (`connection_id`), while it still exists, else
//   3. the connection for the repository's GitHub owner / Azure DevOps organization, else
//   4. (GitHub) the connection that covers every owner, else
//   5. nothing — fine for public repositories.
// So replacing a token here takes effect for every project at once, and nobody enters tokens per project.

import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import {
  can,
  parseRepoUrl,
  type AccessibleRepos,
  pickConnection,
  type CreateGitConnectionInput,
  type GitConnection,
  type GitConnectionProvider,
  type GitConnectionTestResult,
  type RepoCredential,
  type UpdateGitConnectionInput,
} from '@sdlc/contracts'
import { actorOf } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db } from '../db/client'
import { gitConnections, projectRepositories, projects, users } from '../db/schema'
import { forbidden, notFound } from '../http'
import type { Caller } from '../services/context'
import { tokenHint } from './credentials'
import type { GitAuth, GitOptions } from './git'
import type { RepoManager } from './jobs'
import type { RepoRow, RepoRuntime } from './runtime'
import { listAccessibleRepos, verifyToken } from './tokenCheck'

type ConnectionRow = typeof gitConnections.$inferSelect

const NONE: RepoCredential = { source: 'none', connectionId: null, connectionName: null }

/** The GitHub owner / Azure DevOps organization of a stored clone URL (null for local test remotes and workspaces). */
function ownerOf(repo: Pick<RepoRow, 'remoteUrl'>): string | null {
  const parsed = parseRepoUrl(repo.remoteUrl, { allowLocal: true })
  return parsed.ok && parsed.repo.provider !== 'local' ? parsed.repo.owner : null
}

/** The connection a repository uses: the one it was imported with (same provider), else the one for its owner. */
function connectionFor<C extends { id: string; provider: string; owner: string | null }>(
  conns: C[],
  repo: Pick<RepoRow, 'provider' | 'remoteUrl' | 'connectionId'>,
): C | null {
  if (repo.provider === 'workspace' || repo.provider === 'local') return null
  if (repo.connectionId) {
    const pinned = conns.find((c) => c.id === repo.connectionId && c.provider === repo.provider)
    if (pinned) return pinned
  }
  const owner = ownerOf(repo)
  return owner ? pickConnection(conns, repo.provider, owner) : null
}

async function orgConnections(db: Db, orgId: string, provider?: string): Promise<ConnectionRow[]> {
  const rows = await db.select().from(gitConnections).where(eq(gitConnections.orgId, orgId)).orderBy(asc(gitConnections.name))
  return provider ? rows.filter((r) => r.provider === provider) : rows
}

async function orgOfProject(db: Db, projectId: string): Promise<string | null> {
  const [p] = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, projectId)).limit(1)
  return p?.orgId ?? null
}

// ─── Resolution (used by sync, commit, branch creation and connection tests) ──────────────────────

interface Resolved {
  auth: GitAuth
  credential: RepoCredential
}

function resolvedFrom(rt: RepoRuntime, provider: string, match: ConnectionRow): Resolved {
  void rt.db.update(gitConnections).set({ lastUsedAt: new Date() }).where(eq(gitConnections.id, match.id)).catch(() => undefined)
  return {
    auth: { provider: provider as GitAuth['provider'], token: rt.cipher.decrypt(match.credentialEnc) },
    credential: { source: 'connection', connectionId: match.id, connectionName: match.name },
  }
}

/** The connection (if any) that serves `provider` + `owner` in an organisation. */
export async function credentialForUrl(rt: RepoRuntime, orgId: string, provider: string, owner: string | null): Promise<Resolved> {
  if (provider === 'local' || !owner) return { auth: { provider: provider as GitAuth['provider'], token: null }, credential: NONE }
  const match = pickConnection(await orgConnections(rt.db, orgId, provider), provider, owner)
  if (!match) return { auth: { provider: provider as GitAuth['provider'], token: null }, credential: NONE }
  return resolvedFrom(rt, provider, match)
}

/** A connection of the caller's organisation by id (404 otherwise). */
export async function connectionById(db: Db, orgId: string, id: string): Promise<ConnectionRow> {
  const [row] = await db.select().from(gitConnections).where(and(eq(gitConnections.id, id), eq(gitConnections.orgId, orgId))).limit(1)
  if (!row) throw notFound('Git connection')
  return row
}

/** The token of a connection (for the publish flow, which talks to the provider's API directly). */
export function connectionToken(rt: RepoRuntime, row: ConnectionRow): string {
  return rt.cipher.decrypt(row.credentialEnc)
}

export async function resolveRepoCredential(rt: RepoRuntime, repo: RepoRow): Promise<Resolved> {
  if (repo.credentialEnc) {
    return { auth: { provider: repo.provider, token: rt.cipher.decrypt(repo.credentialEnc) }, credential: { source: 'project', connectionId: null, connectionName: null } }
  }
  const orgId = await orgOfProject(rt.db, repo.projectId)
  if (!orgId) return { auth: { provider: repo.provider, token: null }, credential: NONE }
  const match = connectionFor(await orgConnections(rt.db, orgId, repo.provider), repo)
  return match ? resolvedFrom(rt, repo.provider, match) : { auth: { provider: repo.provider, token: null }, credential: NONE }
}

/** Options for network git calls against this repository, with its credential resolved now. */
export async function remoteOptionsFor(rt: RepoRuntime, repo: RepoRow, cwd?: string): Promise<GitOptions> {
  const { auth } = await resolveRepoCredential(rt, repo)
  return { cwd, auth, timeoutMs: rt.gitTimeoutMs, allowFileProtocol: repo.provider === 'local' }
}

/** Which credential a repository uses — for display; never decrypts anything. */
export async function describeCredential(db: Db, repo: RepoRow): Promise<RepoCredential> {
  if (repo.credentialEnc) return { source: 'project', connectionId: null, connectionName: null }
  const orgId = await orgOfProject(db, repo.projectId)
  if (!orgId) return NONE
  const match = connectionFor(await orgConnections(db, orgId, repo.provider), repo)
  return match ? { source: 'connection', connectionId: match.id, connectionName: match.name } : NONE
}

// ─── Admin: list / add / change / remove ─────────────────────────────────────────────────────────

function assertAdmin(user: AuthUser): void {
  if (!can(actorOf(user), undefined, 'org.manage')) throw forbidden('Only an org admin can manage Git connections.')
}

/** Listing connections (and what they reach) is also open to whoever may create projects — to import one. */
function assertCanList(user: AuthUser): void {
  const actor = actorOf(user)
  if (!can(actor, undefined, 'org.manage') && !can(actor, undefined, 'project.create')) {
    throw forbidden('Only an org admin can see the Git connections.')
  }
}

/** Repositories of the organisation that authenticate through connections (no project token). */
async function orgRepositories(db: Db, orgId: string): Promise<RepoRow[]> {
  const rows = await db
    .select({ repo: projectRepositories })
    .from(projectRepositories)
    .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
    .where(and(eq(projects.orgId, orgId), isNull(projects.archivedAt), isNull(projectRepositories.credentialEnc)))
  return rows.map((r) => r.repo).filter((r) => r.provider !== 'workspace')
}

function toConnection(row: ConnectionRow, repositories: number, createdBy: string | null): GitConnection {
  return {
    id: row.id,
    provider: row.provider === 'azure-repos' ? 'azure-repos' : 'github',
    name: row.name,
    owner: row.owner,
    tokenHint: row.credentialHint,
    account: row.account,
    verifiedAt: row.verifiedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    repositories,
    createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listConnections(db: Db, user: AuthUser): Promise<GitConnection[]> {
  assertCanList(user)
  const rows = await orgConnections(db, user.orgId)
  const repos = await orgRepositories(db, user.orgId)
  const usage = new Map<string, number>()
  for (const repo of repos) {
    const match = connectionFor(rows, repo)
    if (match) usage.set(match.id, (usage.get(match.id) ?? 0) + 1)
  }
  const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((id): id is string => Boolean(id)))]
  const creators = creatorIds.length
    ? new Map((await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, creatorIds))).map((u) => [u.id, u.name]))
    : new Map<string, string>()
  return rows.map((r) => toConnection(r, usage.get(r.id) ?? 0, r.createdBy ? (creators.get(r.createdBy) ?? null) : null))
}

/** Repositories a connection's token can reach, optionally filtered by `q` — for importing one as a project. */
export async function listConnectionRepos(rt: RepoRuntime, user: AuthUser, id: string, q?: string): Promise<AccessibleRepos> {
  assertCanList(user)
  const row = await connectionById(rt.db, user.orgId, id)
  const provider: GitConnectionProvider = row.provider === 'azure-repos' ? 'azure-repos' : 'github'
  const found = await listAccessibleRepos(provider, row.owner, rt.cipher.decrypt(row.credentialEnc))
  void rt.db.update(gitConnections).set({ lastUsedAt: new Date() }).where(eq(gitConnections.id, row.id)).catch(() => undefined)
  const needle = q?.trim().toLowerCase()
  const repos = found.repos
    .filter((r) => !needle || r.fullName.toLowerCase().includes(needle) || (r.description ?? '').toLowerCase().includes(needle))
    .map((r) => ({ ...r, connectionId: row.id, connectionName: row.name, provider }))
  return { repos, truncated: found.truncated }
}

export async function testToken(user: AuthUser, input: { provider: GitConnectionProvider; owner?: string; token: string }): Promise<GitConnectionTestResult> {
  assertAdmin(user)
  return { account: await verifyToken(input.provider, input.owner, input.token) }
}

const defaultName = (provider: GitConnectionProvider, owner: string | undefined): string =>
  provider === 'github' ? (owner ? `GitHub · ${owner}` : 'GitHub · all owners') : `Azure DevOps · ${owner}`

/** A name no other connection of the organisation uses: the given/default one, else with the token's account, else numbered. */
function uniqueName(taken: string[], base: string, account: string | null): string {
  const used = new Set(taken.map((n) => n.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  const withAccount = account ? `${base} · ${account}` : base
  if (!used.has(withAccount.toLowerCase())) return withAccount
  for (let n = 2; ; n++) if (!used.has(`${withAccount} (${n})`.toLowerCase())) return `${withAccount} (${n})`
}

/** Re-run repositories that failed while this connection was missing or wrong — they likely work now. */
async function retryFailedRepositories(manager: RepoManager, orgId: string, connection: ConnectionRow, requestedBy: string, via: string): Promise<number> {
  const all = await orgConnections(manager.rt.db, orgId)
  const failed = (await orgRepositories(manager.rt.db, orgId)).filter((r) => r.status === 'failed')
  let n = 0
  for (const repo of failed) {
    if (connectionFor(all, repo)?.id === connection.id) {
      await manager.enqueue(repo.id, 'manual', { requestedBy, via })
      n++
    }
  }
  return n
}

export async function createConnection(manager: RepoManager, caller: Caller, input: CreateGitConnectionInput & { owner?: string }): Promise<GitConnection> {
  const { user } = caller
  assertAdmin(user)
  const { db, cipher } = manager.rt
  const account = await verifyToken(input.provider, input.owner, input.token)
  const row: ConnectionRow = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(gitConnections)
      .values({
        orgId: user.orgId,
        provider: input.provider,
        owner: input.owner ?? null,
        name: input.name?.trim() || uniqueName((await orgConnections(tx, user.orgId)).map((c) => c.name), defaultName(input.provider, input.owner), account),
        credentialEnc: cipher.encrypt(input.token),
        credentialHint: tokenHint(input.token),
        account,
        createdBy: user.id,
      })
      .returning()
    await writeAudit(tx, {
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'git_connection.created',
      resourceType: 'git_connection',
      resourceId: created.id,
      data: { provider: created.provider, owner: created.owner, name: created.name },
      via: caller.via,
    })
    return created
  })
  await retryFailedRepositories(manager, user.orgId, row, user.id, caller.via)
  return (await listConnections(db, user)).find((c) => c.id === row.id) ?? toConnection(row, 0, user.displayName)
}

export async function updateConnection(manager: RepoManager, caller: Caller, id: string, input: UpdateGitConnectionInput): Promise<GitConnection> {
  const { user } = caller
  assertAdmin(user)
  const { db, cipher } = manager.rt
  const [current] = await db.select().from(gitConnections).where(and(eq(gitConnections.id, id), eq(gitConnections.orgId, user.orgId))).limit(1)
  if (!current) throw notFound('Git connection')
  const patch: Partial<typeof gitConnections.$inferInsert> = { updatedAt: new Date() }
  if (input.name) patch.name = input.name
  if (input.token) {
    patch.account = await verifyToken(current.provider === 'azure-repos' ? 'azure-repos' : 'github', current.owner ?? undefined, input.token)
    patch.credentialEnc = cipher.encrypt(input.token)
    patch.credentialHint = tokenHint(input.token)
    patch.verifiedAt = new Date()
  }
  const [row] = await db.transaction(async (tx) => {
    const updated = await tx.update(gitConnections).set(patch).where(eq(gitConnections.id, id)).returning()
    await writeAudit(tx, {
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'git_connection.updated',
      resourceType: 'git_connection',
      resourceId: id,
      data: { name: updated[0].name, token: input.token ? 'replaced' : undefined },
      via: caller.via,
    })
    return updated
  })
  if (input.token) await retryFailedRepositories(manager, user.orgId, row, user.id, caller.via)
  return (await listConnections(db, user)).find((c) => c.id === id) ?? toConnection(row, 0, null)
}

export async function deleteConnection(db: Db, caller: Caller, id: string): Promise<void> {
  const { user } = caller
  assertAdmin(user)
  const [current] = await db.select().from(gitConnections).where(and(eq(gitConnections.id, id), eq(gitConnections.orgId, user.orgId))).limit(1)
  if (!current) throw notFound('Git connection')
  await db.transaction(async (tx) => {
    await tx.delete(gitConnections).where(eq(gitConnections.id, id))
    await writeAudit(tx, {
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'git_connection.deleted',
      resourceType: 'git_connection',
      resourceId: id,
      data: { provider: current.provider, owner: current.owner, name: current.name },
      via: caller.via,
    })
  })
}
