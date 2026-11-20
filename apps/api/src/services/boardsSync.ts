// Azure Boards → stories. Each platform project links to one Azure DevOps project (stored, or derived from its Azure
// Repos repository). Syncing for a user reads the work items assigned to them there — matched by their Azure DevOps
// identity, else their email — with the organisation's Azure Git connection token, and upserts one story per work
// item, assigned to them and linked back to it.
//
// Azure DevOps owns what the work item says; the platform owns how the story moves on the board:
//   • title, description, criteria, priority and tags are refreshed only when the work item changed since the last
//     sync (System.ChangedDate), and criteria keep their ticks when their text is unchanged;
//   • the status follows the work item's state category only when that state changed since the last sync, so a
//     story moved on the board stays where it was put until Azure DevOps moves;
//   • items no longer assigned to the user are left as they are; long-closed items are not imported.

import { randomUUID } from 'crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  boardsDefaultsFromRepo,
  labelsForAdoTags,
  storyPriorityForAdo,
  storyStatusForCategory,
  type AcceptanceCriterion,
  type AzureBoardsSettings,
  type BoardsIdentity,
  type BoardsPruneResult,
  type BoardsSyncResponse,
  type BoardsSyncResult,
  type ProjectBoards,
  type UpdateBoardsIdentityInput,
  type UpdateProjectBoardsInput,
} from '@sdlc/contracts'
import {
  AdoRequestError,
  fetchAssignedWorkItems,
  fetchAreaPaths,
  fetchStateCategories,
  fetchWorkItemAreaPaths,
  isUnderArea,
  guessStateCategory,
  ME,
  patAuthHeader,
  type AdoAccess,
  type AdoStateCategory,
  type AdoWorkItem,
  type FetchLike,
} from '@sdlc/core'
import { assertCan, loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import { projectBoards, storyExternalLinks, userExternalIdentities } from '../db/boardsSchema'
import type { Db } from '../db/client'
import { projectMembers, projectRepositories, projects, runs, stories } from '../db/schema'
import { credentialForUrl } from '../repo/connections'
import type { RepoRuntime } from '../repo/runtime'
import { HttpError } from '../http'
import type { Caller, ServiceDeps } from './context'
import { ownAdoAccess } from './myWorkItems'
import { bottomRank, lockRanks } from './storyRank'

const PROVIDER = 'azure-boards'
/** A closed work item last changed longer ago than this is not imported (it is still updated if already linked). */
const CLOSED_IMPORT_WINDOW_MS = 30 * 24 * 60 * 60_000
/** A user's sync runs at most this often unless forced (both clients sync on load). */
const THROTTLE_MS = 60_000

export interface BoardsDeps extends ServiceDeps {
  rt: RepoRuntime
  /** Injected in tests. */
  fetch?: FetchLike
}

const lastSync = new Map<string, number>()

// ─── Settings ──────────────────────────────────────────────────────────────────────────────────────

async function resolveSettings(db: Db, projectId: string): Promise<{ settings: AzureBoardsSettings | null; derived: boolean; lastSyncedAt: Date | null }> {
  const [row] = await db.select().from(projectBoards).where(eq(projectBoards.projectId, projectId)).limit(1)
  if (row) {
    return {
      settings: { enabled: row.enabled, organization: row.organization, project: row.adoProject, workItemTypes: row.workItemTypes, areaPath: row.areaPath },
      derived: false,
      lastSyncedAt: row.lastSyncedAt,
    }
  }
  const [repo] = await db.select({ remoteUrl: projectRepositories.remoteUrl }).from(projectRepositories).where(eq(projectRepositories.projectId, projectId)).limit(1)
  return { settings: boardsDefaultsFromRepo(repo?.remoteUrl), derived: true, lastSyncedAt: null }
}

async function hasAzureConnection(rt: RepoRuntime, orgId: string, organization: string): Promise<boolean> {
  return !!(await credentialForUrl(rt, orgId, 'azure-repos', organization)).auth.token
}

export async function getProjectBoards(deps: BoardsDeps, user: AuthUser, key: string): Promise<ProjectBoards> {
  const access = await loadProjectAccess(deps.db, user, key)
  const r = await resolveSettings(deps.db, access.project.id)
  return {
    settings: r.settings,
    derived: r.derived,
    hasConnection: r.settings ? await hasAzureConnection(deps.rt, user.orgId, r.settings.organization) : false,
    lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
  }
}

/** Link (or re-link) a project to an Azure DevOps project. Owners only, like the repository. */
export async function updateProjectBoards(deps: BoardsDeps, caller: Caller, key: string, input: UpdateProjectBoardsInput): Promise<ProjectBoards> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  assertCan(access, 'project.update')
  const values = {
    enabled: input.enabled,
    organization: input.organization,
    adoProject: input.project,
    workItemTypes: [...new Set(input.workItemTypes)],
    areaPath: input.areaPath || null,
    updatedBy: caller.user.id,
    updatedAt: new Date(),
  }
  await deps.db.transaction(async (tx) => {
    await tx
      .insert(projectBoards)
      .values({ projectId: access.project.id, ...values })
      .onConflictDoUpdate({ target: projectBoards.projectId, set: values })
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'project.boards_linked',
      resourceType: 'project',
      resourceId: access.project.id,
      data: { organization: input.organization, project: input.project, areaPath: values.areaPath, enabled: input.enabled, workItemTypes: values.workItemTypes },
      via: caller.via,
    })
  })
  deps.bus.publish({ type: 'project.changed', projectKey: access.project.key, action: 'updated', actorId: caller.user.id })
  return getProjectBoards(deps, caller.user, key)
}

/**
 * An Azure DevOps project's area paths (root first), for picking the area a platform project syncs from. Uses the
 * caller's own Azure DevOps access for that organization, else the organisation's connection.
 */
export async function listBoardsAreas(deps: BoardsDeps, user: AuthUser, key: string, organization: string, adoProject: string): Promise<string[]> {
  await loadProjectAccess(deps.db, user, key)
  const token =
    (await ownAdoAccess(deps, user, organization))?.token ?? (await credentialForUrl(deps.rt, user.orgId, 'azure-repos', organization)).auth.token
  if (!token) throw new HttpError(409, 'no_connection', `No Azure DevOps access for “${organization}”. Add a Git connection or your own token first.`)
  try {
    return await fetchAreaPaths({ org: organization, project: adoProject, authorization: patAuthHeader(token), fetch: deps.fetch })
  } catch (err) {
    if (err instanceof AdoRequestError && err.status === 404) throw new HttpError(422, 'not_found', `Azure DevOps project “${adoProject}” wasn’t found in “${organization}”.`)
    if (err instanceof AdoRequestError && [401, 403, 203].includes(err.status)) {
      throw new HttpError(422, 'token_rejected', 'The Azure DevOps token can’t read this project’s areas. It needs the Work Items (Read) scope.')
    }
    throw new HttpError(502, 'ado_request_failed', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Which linked stories are outside `area`, by story number: those whose work item's area path is known (Azure DevOps
 * still returns it) and is neither the area nor under it.
 */
export function selectOutOfArea<T extends { number: number; externalId: string }>(
  linked: readonly T[],
  areas: ReadonlyMap<number, string>,
  area: string,
): Array<T & { workItemId: number; areaPath: string }> {
  return linked
    .map((l) => ({ ...l, workItemId: Number(l.externalId), areaPath: areas.get(Number(l.externalId)) }))
    .filter((l): l is T & { workItemId: number; areaPath: string } => l.areaPath !== undefined && !isUnderArea(l.areaPath, area))
    .sort((a, b) => a.number - b.number)
}

/**
 * The project's synced stories whose work items are outside its area (imported before the area was set, or moved
 * since). Listed with `dryRun`; otherwise deleted with their links and runs (owners only, audited). Work items Azure DevOps no
 * longer returns are kept: there is no way to tell where they belong.
 */
export async function pruneOutOfArea(deps: BoardsDeps, caller: Caller, key: string, opts: { dryRun: boolean }): Promise<BoardsPruneResult> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  assertCan(access, 'project.update')
  const { settings } = await resolveSettings(deps.db, access.project.id)
  if (!settings?.areaPath) throw new HttpError(409, 'no_area', 'Pick an area for this project first.')
  const area = settings.areaPath
  const token =
    (await ownAdoAccess(deps, caller.user, settings.organization))?.token ??
    (await credentialForUrl(deps.rt, caller.user.orgId, 'azure-repos', settings.organization)).auth.token
  if (!token) throw new HttpError(409, 'no_connection', `No Azure DevOps access for “${settings.organization}”.`)

  const linked = await deps.db
    .select({ storyId: stories.id, number: stories.number, title: stories.title, externalId: storyExternalLinks.externalId })
    .from(storyExternalLinks)
    .innerJoin(stories, eq(stories.id, storyExternalLinks.storyId))
    .where(and(eq(storyExternalLinks.projectId, access.project.id), eq(storyExternalLinks.provider, PROVIDER)))
  const ids = linked.map((l) => Number(l.externalId)).filter((n) => Number.isInteger(n) && n > 0)
  let areas: Map<number, string>
  try {
    areas = await fetchWorkItemAreaPaths({ org: settings.organization, authorization: patAuthHeader(token), fetch: deps.fetch }, ids)
  } catch (err) {
    throw new HttpError(502, 'ado_request_failed', describeError(err, settings))
  }
  const outside = selectOutOfArea(linked, areas, area)
  // Deleting a story cascades to its runs (and their steps, events, changes, evaluations): count them for the confirm.
  const [{ n: runCount }] = outside.length
    ? await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(runs)
        .where(inArray(runs.storyId, outside.map((o) => o.storyId)))
    : [{ n: 0 }]
  const result: BoardsPruneResult = {
    areaPath: area,
    stories: outside.map((o) => ({ number: o.number, title: o.title, workItemId: o.workItemId, areaPath: o.areaPath })),
    runs: Number(runCount) || 0,
    removed: false,
  }
  if (opts.dryRun || outside.length === 0) return result

  await deps.db.transaction(async (tx) => {
    await tx.delete(stories).where(inArray(stories.id, outside.map((o) => o.storyId)))
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'project.boards_pruned',
      resourceType: 'project',
      resourceId: access.project.id,
      data: { areaPath: area, runs: result.runs, removed: outside.map((o) => ({ number: o.number, workItemId: o.workItemId, title: o.title, areaPath: o.areaPath })) },
      via: caller.via,
    })
  })
  for (const o of outside) {
    deps.bus.publish({ type: 'story.changed', projectKey: access.project.key, storyNumber: o.number, action: 'deleted', actorId: caller.user.id })
  }
  return { ...result, removed: true }
}

// ─── Identity ──────────────────────────────────────────────────────────────────────────────────────

export async function getBoardsIdentity(db: Db, user: AuthUser): Promise<BoardsIdentity> {
  const [row] = await db
    .select({ identity: userExternalIdentities.identity })
    .from(userExternalIdentities)
    .where(and(eq(userExternalIdentities.userId, user.id), eq(userExternalIdentities.provider, PROVIDER)))
    .limit(1)
  return { identity: row?.identity ?? user.email, override: row?.identity ?? null }
}

export async function setBoardsIdentity(db: Db, user: AuthUser, input: UpdateBoardsIdentityInput): Promise<BoardsIdentity> {
  if (!input.identity) {
    await db.delete(userExternalIdentities).where(and(eq(userExternalIdentities.userId, user.id), eq(userExternalIdentities.provider, PROVIDER)))
  } else {
    await db
      .insert(userExternalIdentities)
      .values({ userId: user.id, provider: PROVIDER, identity: input.identity })
      .onConflictDoUpdate({ target: [userExternalIdentities.userId, userExternalIdentities.provider], set: { identity: input.identity, updatedAt: new Date() } })
  }
  lastSync.delete(user.id)
  return getBoardsIdentity(db, user)
}

// ─── Sync ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sync the caller's assigned work items into every project they belong to that is linked to Azure Boards (or just
 * `projectKey`). Throttled per user unless `force`.
 */
export async function syncMyWorkItems(deps: BoardsDeps, caller: Caller, opts: { projectKey?: string; force?: boolean } = {}): Promise<BoardsSyncResponse> {
  const user = caller.user
  const now = Date.now()
  if (!opts.force && !opts.projectKey && now - (lastSync.get(user.id) ?? 0) < THROTTLE_MS) return { results: [], throttled: true }
  if (!opts.projectKey) lastSync.set(user.id, now)

  const keys = opts.projectKey
    ? [opts.projectKey]
    : (
        await deps.db
          .select({ key: projects.key })
          .from(projectMembers)
          .innerJoin(projects, eq(projects.id, projectMembers.projectId))
          .where(and(eq(projectMembers.userId, user.id), eq(projects.orgId, user.orgId), isNull(projects.archivedAt)))
      ).map((r) => r.key)

  const { identity } = await getBoardsIdentity(deps.db, user)
  const results: BoardsSyncResult[] = []
  for (const key of keys) {
    const result = await syncProject(deps, caller, key, identity, !!opts.projectKey)
    if (result) results.push(result)
  }
  return { results, throttled: false }
}

/** One project. Undefined when it isn't linked to Azure Boards and wasn't asked for explicitly. */
async function syncProject(deps: BoardsDeps, caller: Caller, key: string, identity: string, explicit: boolean): Promise<BoardsSyncResult | undefined> {
  const empty = { projectKey: key, created: 0, updated: 0, found: 0 }
  let access: ProjectAccess
  try {
    access = await loadProjectAccess(deps.db, caller.user, key)
    assertCan(access, 'story.pickup')
  } catch {
    return explicit ? { ...empty, error: 'You can’t sync stories in this project.' } : undefined
  }
  const { settings, derived } = await resolveSettings(deps.db, access.project.id)
  if (!settings || !settings.enabled) {
    return explicit ? { ...empty, projectKey: access.project.key, error: 'This project isn’t linked to Azure Boards. A project owner can link it in the project’s settings.' } : undefined
  }
  // The caller's own Azure DevOps access (My work items) matches them exactly (`@Me`); else the organisation's
  // connection, matched by their email / identity.
  const own = await ownAdoAccess(deps, caller.user, settings.organization)
  const resolved = own ? null : await credentialForUrl(deps.rt, caller.user.orgId, 'azure-repos', settings.organization)
  const plan = syncAccess(own?.token, resolved?.auth.token, identity)
  if (!plan) {
    return { ...empty, projectKey: access.project.key, error: `No Azure DevOps connection for “${settings.organization}”. An org admin can add one in Settings › Git connections.` }
  }
  const ado: AdoAccess = { org: settings.organization, project: settings.project, authorization: patAuthHeader(plan.token), fetch: deps.fetch }

  try {
    const items = await fetchAssignedWorkItems(ado, { identity: plan.identity, types: settings.workItemTypes, areaPath: settings.areaPath })
    const categories = await stateCategories(ado, items)
    const counts = await upsertStories(deps, caller, access, items, categories)
    await recordSynced(deps, access.project.id, settings, derived, caller.user.id)
    return { projectKey: access.project.key, ...counts, found: items.length, error: null }
  } catch (err) {
    return { ...empty, projectKey: access.project.key, error: describeError(err, settings) }
  }
}

/**
 * The token and WIQL identity a project sync uses: the caller's own token matches them exactly as `@Me`; the
 * organisation's connection belongs to someone else, so it matches their email / Azure DevOps identity. Null: neither.
 */
export function syncAccess(ownToken: string | null | undefined, orgToken: string | null | undefined, identity: string): { token: string; identity: string } | null {
  if (ownToken) return { token: ownToken, identity: ME }
  if (orgToken) return { token: orgToken, identity }
  return null
}

/** A story's description from its work item: the item's own text, then a line naming its parent (if it has one). */
export function storyDescription(item: Pick<AdoWorkItem, 'description' | 'parentId' | 'parent'>): string {
  const parent = item.parent ?? (item.parentId !== null ? { id: item.parentId, title: '' } : null)
  if (!parent) return item.description
  const line = `Parent: #${parent.id}${parent.title ? ` ${parent.title}` : ''}`
  return item.description ? `${item.description}\n\n${line}` : line
}

function describeError(err: unknown, s: AzureBoardsSettings): string {
  if (err instanceof AdoRequestError) {
    if (err.status === 401 || err.status === 403 || err.status === 203) {
      return `The Azure DevOps connection for “${s.organization}” can’t read work items. Its token needs the Work Items (Read) scope.`
    }
    if (err.status === 404) return `Azure DevOps project “${s.project}” wasn’t found in “${s.organization}”.`
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/** Each work item type's state categories, read once per sync; a type that can't be read falls back to known names. */
async function stateCategories(ado: AdoAccess, items: AdoWorkItem[]): Promise<Map<string, Record<string, AdoStateCategory>>> {
  const out = new Map<string, Record<string, AdoStateCategory>>()
  for (const type of new Set(items.map((i) => i.type))) {
    out.set(type, await fetchStateCategories(ado, type).catch(() => ({})))
  }
  return out
}

function categoryOf(item: AdoWorkItem, categories: Map<string, Record<string, AdoStateCategory>>): AdoStateCategory {
  return categories.get(item.type)?.[item.state] ?? guessStateCategory(item.state)
}

/** Keep a criterion's id and tick when its text is unchanged. */
function mergeCriteria(current: AcceptanceCriterion[], texts: string[]): AcceptanceCriterion[] {
  const byText = new Map(current.map((c) => [c.text.trim().toLowerCase(), c]))
  return texts.map((text) => byText.get(text.trim().toLowerCase()) ?? { id: randomUUID(), text, met: false })
}

async function upsertStories(
  deps: BoardsDeps,
  caller: Caller,
  access: ProjectAccess,
  items: AdoWorkItem[],
  categories: Map<string, Record<string, AdoStateCategory>>,
): Promise<{ created: number; updated: number }> {
  if (items.length === 0) return { created: 0, updated: 0 }
  const projectId = access.project.id
  const links = await deps.db
    .select({ link: storyExternalLinks, story: stories })
    .from(storyExternalLinks)
    .innerJoin(stories, eq(stories.id, storyExternalLinks.storyId))
    .where(
      and(
        eq(storyExternalLinks.projectId, projectId),
        eq(storyExternalLinks.provider, PROVIDER),
        inArray(
          storyExternalLinks.externalId,
          items.map((i) => String(i.id)),
        ),
      ),
    )
  const linked = new Map(links.map((l) => [l.link.externalId, l]))
  const changed: Array<{ number: number; action: string }> = []
  let created = 0
  let updated = 0

  for (const item of items) {
    const category = categoryOf(item, categories)
    const changedAt = new Date(item.changedAt)
    const existing = linked.get(String(item.id))

    if (!existing) {
      const closed = category === 'Completed' || category === 'Removed'
      if (closed && Date.now() - changedAt.getTime() > CLOSED_IMPORT_WINDOW_MS) continue
      const number = await deps.db.transaction(async (tx) => {
        const [{ n }] = await tx
          .update(projects)
          .set({ nextStoryNumber: sql`${projects.nextStoryNumber} + 1` })
          .where(eq(projects.id, projectId))
          .returning({ n: sql<number>`${projects.nextStoryNumber} - 1` })
        await lockRanks(tx, projectId)
        const rank = await bottomRank(tx, projectId)
        const [row] = await tx
          .insert(stories)
          .values({
            projectId,
            number: n,
            title: item.title,
            description: storyDescription(item),
            acceptanceCriteria: item.acceptanceCriteria.map((text) => ({ id: randomUUID(), text, met: false })),
            priority: storyPriorityForAdo(item.priority),
            status: storyStatusForCategory(category),
            labels: labelsForAdoTags(item.tags),
            rank,
            assigneeId: caller.user.id,
            createdBy: caller.user.id,
          })
          .returning()
        await tx.insert(storyExternalLinks).values({
          storyId: row.id,
          projectId,
          provider: PROVIDER,
          externalId: String(item.id),
          url: item.url,
          itemType: item.type,
          state: item.state,
          changedAt,
        })
        await writeAudit(tx, {
          orgId: caller.user.orgId,
          projectId,
          actorUserId: caller.user.id,
          action: 'story.created',
          resourceType: 'story',
          resourceId: row.id,
          data: { key: `${access.project.key}-${n}`, title: item.title, status: row.status, source: PROVIDER, workItem: item.id, workItemUrl: item.url },
          via: caller.via,
        })
        return n
      })
      created += 1
      changed.push({ number, action: 'created' })
      continue
    }

    const { link, story } = existing
    const contentChanged = changedAt.getTime() > link.changedAt.getTime()
    const stateChanged = item.state !== link.state
    const patch: Partial<typeof stories.$inferInsert> = {}
    if (contentChanged) {
      if (story.title !== item.title) patch.title = item.title
      const description = storyDescription(item)
      if (story.description !== description) patch.description = description
      const criteria = mergeCriteria(story.acceptanceCriteria, item.acceptanceCriteria)
      if (JSON.stringify(criteria) !== JSON.stringify(story.acceptanceCriteria)) patch.acceptanceCriteria = criteria
      const priority = storyPriorityForAdo(item.priority)
      if (story.priority !== priority) patch.priority = priority
      const labels = [...new Set([...story.labels, ...labelsForAdoTags(item.tags)])].slice(0, 10)
      if (labels.length !== story.labels.length) patch.labels = labels
    }
    if (stateChanged) {
      const status = storyStatusForCategory(category)
      if (story.status !== status) patch.status = status
    }
    if (story.assigneeId !== caller.user.id) patch.assigneeId = caller.user.id

    await deps.db.transaction(async (tx) => {
      await tx.update(storyExternalLinks).set({ state: item.state, itemType: item.type, url: item.url, changedAt, syncedAt: new Date() }).where(eq(storyExternalLinks.storyId, story.id))
      if (Object.keys(patch).length === 0) return
      await tx
        .update(stories)
        .set({ ...patch, version: sql`${stories.version} + 1`, updatedAt: new Date() })
        .where(eq(stories.id, story.id))
      await writeAudit(tx, {
        orgId: caller.user.orgId,
        projectId,
        actorUserId: caller.user.id,
        action: 'story.synced',
        resourceType: 'story',
        resourceId: story.id,
        data: {
          key: `${access.project.key}-${story.number}`,
          workItem: item.id,
          fields: Object.keys(patch),
          ...(patch.status ? { from: story.status, to: patch.status, state: item.state } : {}),
        },
        via: caller.via,
      })
    })
    if (Object.keys(patch).length > 0) {
      updated += 1
      changed.push({ number: story.number, action: 'synced' })
    }
  }

  for (const c of changed) {
    deps.bus.publish({ type: 'story.changed', projectKey: access.project.key, storyNumber: c.number, action: c.action, actorId: caller.user.id })
  }
  return { created, updated }
}

/** Stamp the sync time; a derived link is saved on its first successful sync so the project shows it as linked. */
async function recordSynced(deps: BoardsDeps, projectId: string, settings: AzureBoardsSettings, derived: boolean, userId: string): Promise<void> {
  const now = new Date()
  if (derived) {
    await deps.db
      .insert(projectBoards)
      .values({
        projectId,
        enabled: settings.enabled,
        organization: settings.organization,
        adoProject: settings.project,
        workItemTypes: settings.workItemTypes,
        areaPath: settings.areaPath,
        lastSyncedAt: now,
        updatedBy: userId,
      })
      .onConflictDoUpdate({ target: projectBoards.projectId, set: { lastSyncedAt: now } })
  } else {
    await deps.db.update(projectBoards).set({ lastSyncedAt: now }).where(eq(projectBoards.projectId, projectId))
  }
}

/** For tests: forget the per-user throttle. */
export function resetBoardsSyncThrottle(): void {
  lastSync.clear()
}
