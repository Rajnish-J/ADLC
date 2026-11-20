// "My work items": every Azure DevOps work item assigned to the signed-in user, read live (nothing is copied into
// stories) across all projects of their organization, as `@Me` — so the token must be theirs. Either their own
// personal access token (checked before it is saved: it must reach the organization and read work items; encrypted
// like Git connection tokens, never returned) or a link to an organisation Azure Git connection whose token is
// theirs (they added it, or its account is their Azure DevOps identity).

import { and, eq, inArray } from 'drizzle-orm'
import type {
  AdoBoardCategory,
  AdoConnectionSuggestion,
  AdoTokenResponse,
  LinkAdoConnectionInput,
  MyWorkItem,
  MyWorkItemsResponse,
  SetAdoTokenInput,
} from '@sdlc/contracts'
import {
  AdoRequestError,
  fetchMyWorkItems,
  fetchStateCategories,
  guessStateCategory,
  patAuthHeader,
  type AdoMyWorkItem,
  type AdoOrgAccess,
  type AdoStateCategory,
  type FetchLike,
} from '@sdlc/core'
import type { AuthUser } from '../auth'
import { storyExternalLinks, userAdoTokens } from '../db/boardsSchema'
import type { Db } from '../db/client'
import { gitConnections, projects, stories } from '../db/schema'
import { HttpError } from '../http'
import { tokenHint } from '../repo/credentials'
import type { RepoRuntime } from '../repo/runtime'
import { verifyToken } from '../repo/tokenCheck'
import { getBoardsIdentity } from './boardsSync'

const PROVIDER = 'azure-boards'
/** The board shows at most this many (the most recently changed). */
const MAX_ITEMS = 500
const CATEGORY_TTL_MS = 10 * 60_000

export interface MyWorkItemsDeps {
  db: Db
  rt: RepoRuntime
  /** Injected in tests. */
  fetch?: FetchLike
  /** Injected in tests (skips the connectionData check). */
  verify?: typeof verifyToken
}

const NEEDS_SCOPE = 'The token can’t read work items. Create it with the Work Items (Read) scope.'
const MISSING = 'Add your Azure DevOps token, or use a Git connection that has your token, in Settings › Profile to see your work items.'

type ConnectionRow = typeof gitConnections.$inferSelect

// ─── Token / connection ────────────────────────────────────────────────────────────────────────────

/**
 * Whether a connection's token is the user's: they added it, or the account Azure DevOps reported for it is their
 * email / Azure DevOps identity. Anything else would show the token owner's work items as "mine".
 */
export function connectionUsable(
  c: Pick<ConnectionRow, 'createdBy' | 'account'>,
  user: Pick<AuthUser, 'id' | 'email'>,
  identity: string,
): { usable: boolean; reason: string | null } {
  const account = c.account?.trim().toLowerCase()
  if (c.createdBy === user.id || (account && (account === user.email.toLowerCase() || account === identity.trim().toLowerCase()))) {
    return { usable: true, reason: null }
  }
  return { usable: false, reason: `Its token belongs to ${c.account ?? 'someone else'}, so it would show their work items, not yours.` }
}

async function azureConnections(db: Db, user: AuthUser): Promise<ConnectionRow[]> {
  return db
    .select()
    .from(gitConnections)
    .where(and(eq(gitConnections.orgId, user.orgId), eq(gitConnections.provider, 'azure-repos')))
}

/** My stored access (null when none) and the organisation's Azure Git connections I could use instead. */
export async function getAdoToken(db: Db, user: AuthUser): Promise<AdoTokenResponse> {
  const [[row], connections, { identity }] = await Promise.all([
    db.select().from(userAdoTokens).where(eq(userAdoTokens.userId, user.id)).limit(1),
    azureConnections(db, user),
    getBoardsIdentity(db, user),
  ])
  const suggestions: AdoConnectionSuggestion[] = connections
    .filter((c) => c.owner)
    .map((c) => ({ connectionId: c.id, name: c.name, organization: c.owner!, account: c.account, hint: c.credentialHint, ...connectionUsable(c, user, identity) }))
    .sort((a, b) => Number(b.usable) - Number(a.usable) || a.name.localeCompare(b.name))
  if (!row) return { token: null, suggestions }
  const linked = row.connectionId ? connections.find((c) => c.id === row.connectionId) : undefined
  return {
    token: {
      source: row.connectionId ? 'connection' : 'token',
      connectionName: linked?.name ?? null,
      organization: linked?.owner ?? row.organization,
      account: linked ? linked.account : row.account,
      hint: linked ? linked.credentialHint : (row.credentialHint ?? '…'),
      verifiedAt: (linked?.verifiedAt ?? row.verifiedAt).toISOString(),
    },
    suggestions,
  }
}

/** Check the token (reaches the organization, can read work items), then store it encrypted. */
export async function setAdoToken(deps: MyWorkItemsDeps, user: AuthUser, input: SetAdoTokenInput): Promise<AdoTokenResponse> {
  const account = await (deps.verify ?? verifyToken)('azure-repos', input.organization, input.token)
  await probe(deps, input.organization, input.token)
  await save(deps.db, user, {
    organization: input.organization,
    connectionId: null,
    credentialEnc: deps.rt.cipher.encrypt(input.token),
    credentialHint: tokenHint(input.token),
    account,
  })
  return getAdoToken(deps.db, user)
}

/** Use an organisation Azure Git connection whose token is the caller's (after checking it can read work items). */
export async function linkAdoConnection(deps: MyWorkItemsDeps, user: AuthUser, input: LinkAdoConnectionInput): Promise<AdoTokenResponse> {
  const conn = (await azureConnections(deps.db, user)).find((c) => c.id === input.connectionId)
  if (!conn || !conn.owner) throw new HttpError(404, 'not_found', 'That Azure DevOps connection was not found.')
  const check = connectionUsable(conn, user, (await getBoardsIdentity(deps.db, user)).identity)
  if (!check.usable) throw new HttpError(403, 'forbidden', check.reason ?? 'You can’t use that connection.')
  await probe(deps, conn.owner, deps.rt.cipher.decrypt(conn.credentialEnc))
  await save(deps.db, user, { organization: conn.owner, connectionId: conn.id, credentialEnc: null, credentialHint: null, account: conn.account })
  return getAdoToken(deps.db, user)
}

async function probe(deps: MyWorkItemsDeps, organization: string, token: string): Promise<void> {
  try {
    await fetchMyWorkItems(orgAccess(deps, organization, token), { max: 1 })
  } catch (err) {
    throw describe(err, organization, 422)
  }
}

async function save(
  db: Db,
  user: AuthUser,
  v: { organization: string; connectionId: string | null; credentialEnc: string | null; credentialHint: string | null; account: string | null },
): Promise<void> {
  const values = { ...v, verifiedAt: new Date(), updatedAt: new Date() }
  await db
    .insert(userAdoTokens)
    .values({ userId: user.id, ...values })
    .onConflictDoUpdate({ target: userAdoTokens.userId, set: values })
  categoryCache.clear()
}

export async function deleteAdoToken(db: Db, user: AuthUser): Promise<{ ok: true }> {
  await db.delete(userAdoTokens).where(eq(userAdoTokens.userId, user.id))
  return { ok: true }
}

/** The caller's organization and token: their own, or the linked connection's (if still theirs). 409 without one. */
async function resolveAccess(deps: MyWorkItemsDeps, user: AuthUser): Promise<{ organization: string; token: string }> {
  const [row] = await deps.db.select().from(userAdoTokens).where(eq(userAdoTokens.userId, user.id)).limit(1)
  if (!row) throw new HttpError(409, 'ado_token_missing', MISSING)
  try {
    if (row.connectionId) {
      const conn = (await azureConnections(deps.db, user)).find((c) => c.id === row.connectionId)
      if (!conn?.owner) throw new HttpError(409, 'ado_token_missing', MISSING)
      // The connection's token may have been replaced since it was linked: it must still be the caller's.
      const check = connectionUsable(conn, user, (await getBoardsIdentity(deps.db, user)).identity)
      if (!check.usable) throw new HttpError(409, 'ado_token_missing', `The linked connection “${conn.name}” can’t be used any more. ${check.reason} ${MISSING}`)
      return { organization: conn.owner, token: deps.rt.cipher.decrypt(conn.credentialEnc) }
    }
    if (!row.credentialEnc) throw new HttpError(409, 'ado_token_missing', MISSING)
    return { organization: row.organization, token: deps.rt.cipher.decrypt(row.credentialEnc) }
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(409, 'ado_token_missing', `Your saved Azure DevOps token can’t be read any more. ${MISSING}`)
  }
}

/**
 * The caller's own Azure DevOps access for `organization` (their token or linked connection), or null; never throws.
 * Story sync prefers it: it matches the caller exactly (`@Me`).
 */
export async function ownAdoAccess(
  deps: Pick<MyWorkItemsDeps, 'db' | 'rt'>,
  user: AuthUser,
  organization: string,
): Promise<{ organization: string; token: string } | null> {
  try {
    const access = await resolveAccess({ db: deps.db, rt: deps.rt }, user)
    return access.organization.toLowerCase() === organization.toLowerCase() ? access : null
  } catch {
    return null
  }
}

// ─── Work items ────────────────────────────────────────────────────────────────────────────────────

/** Every work item assigned to the caller in their Azure DevOps organization. 409 `ado_token_missing` without access. */
export async function listMyWorkItems(deps: MyWorkItemsDeps, user: AuthUser): Promise<MyWorkItemsResponse> {
  const { organization, token } = await resolveAccess(deps, user)
  const access = orgAccess(deps, organization, token)
  let items: AdoMyWorkItem[]
  try {
    items = await fetchMyWorkItems(access, { max: MAX_ITEMS + 1 })
  } catch (err) {
    throw describe(err, organization, 502)
  }
  const truncated = items.length > MAX_ITEMS
  items = items.slice(0, MAX_ITEMS)

  const categories = await stateCategories(access, items)
  const linked = await linkedStories(deps.db, user, items.map((i) => String(i.id)))
  const out: MyWorkItem[] = items.map((i) => ({
    id: i.id,
    title: i.title,
    type: i.type,
    state: i.state,
    category: boardCategory(categories.get(`${i.project}\u0000${i.type}`)?.[i.state] ?? guessStateCategory(i.state)),
    project: i.project,
    areaPath: i.areaPath,
    iterationPath: i.iterationPath,
    parent: i.parent,
    priority: i.priority,
    tags: i.tags,
    changedAt: i.changedAt,
    url: i.url,
    linkedStory: linked.get(String(i.id)) ?? null,
  }))
  return { organization, fetchedAt: new Date().toISOString(), truncated, items: out }
}

/** Removed items are filtered out by the query; anything unexpected lands in Active. */
export function boardCategory(c: AdoStateCategory | string): AdoBoardCategory {
  return c === 'Proposed' || c === 'Resolved' || c === 'Completed' ? c : 'InProgress'
}

function orgAccess(deps: MyWorkItemsDeps, org: string, token: string): AdoOrgAccess {
  return { org, authorization: patAuthHeader(token), fetch: deps.fetch }
}

function describe(err: unknown, org: string, fallbackStatus: number): HttpError {
  if (err instanceof HttpError) return err
  if (err instanceof AdoRequestError) {
    if (err.status === 401 || err.status === 403 || err.status === 203) return new HttpError(422, 'token_rejected', NEEDS_SCOPE)
    if (err.status === 404) return new HttpError(422, 'token_check_failed', `There is no Azure DevOps organization called “${org}”.`)
    return new HttpError(fallbackStatus, 'ado_request_failed', err.message)
  }
  return new HttpError(fallbackStatus, 'ado_request_failed', err instanceof Error ? err.message : String(err))
}

// State categories per (organization, project, type), cached for a few minutes: they change only when the process does.
const categoryCache = new Map<string, { at: number; value: Record<string, AdoStateCategory> }>()

async function stateCategories(access: AdoOrgAccess, items: AdoMyWorkItem[]): Promise<Map<string, Record<string, AdoStateCategory>>> {
  const out = new Map<string, Record<string, AdoStateCategory>>()
  const pairs = new Map<string, { project: string; type: string }>()
  for (const i of items) pairs.set(`${i.project}\u0000${i.type}`, { project: i.project, type: i.type })
  await Promise.all(
    [...pairs].map(async ([key, { project, type }]) => {
      const cacheKey = `${access.org.toLowerCase()}\u0000${key}`
      const hit = categoryCache.get(cacheKey)
      if (hit && Date.now() - hit.at < CATEGORY_TTL_MS) {
        out.set(key, hit.value)
        return
      }
      const value = await fetchStateCategories({ ...access, project }, type).catch(() => ({}) as Record<string, AdoStateCategory>)
      categoryCache.set(cacheKey, { at: Date.now(), value })
      out.set(key, value)
    }),
  )
  return out
}

/** Work item id → the story synced from it, in the caller's organization. */
async function linkedStories(db: Db, user: AuthUser, ids: string[]): Promise<Map<string, { projectKey: string; number: number }>> {
  const out = new Map<string, { projectKey: string; number: number }>()
  if (ids.length === 0) return out
  const rows = await db
    .select({ externalId: storyExternalLinks.externalId, projectKey: projects.key, number: stories.number })
    .from(storyExternalLinks)
    .innerJoin(stories, eq(stories.id, storyExternalLinks.storyId))
    .innerJoin(projects, eq(projects.id, storyExternalLinks.projectId))
    .where(and(eq(storyExternalLinks.provider, PROVIDER), inArray(storyExternalLinks.externalId, ids), eq(projects.orgId, user.orgId)))
  for (const r of rows) if (!out.has(r.externalId)) out.set(r.externalId, { projectKey: r.projectKey, number: r.number })
  return out
}
