// Story and project memory. Story items are written by whoever works on the story; project items are curated by
// leads — added directly, or proposed from a story (promotion, or the roll-up when a story is done) and accepted.

import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  can,
  type CreateMemoryInputSchema,
  type DecideMemoryInput,
  type MemoryItem,
  type MemoryListQuerySchema,
  readProjectSettings,
  type UpdateMemoryInput,
} from '@sdlc/contracts'
import type { z } from 'zod'
import { assertCan, loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db, Tx } from '../db/client'
import { memoryItems, stories } from '../db/schema'
import { badRequest, conflict, forbidden, notFound } from '../http'
import type { Caller, ServiceDeps } from './context'
import { projectMemoryStatus } from './memoryCapture'
import { memoryActions, memoryColumns, presentMemory, type MemoryRecord } from './memoryPresent'
import { loadOwnedRun } from './runAccess'
import { fuseRankings, type MemoryIndexer } from './memoryIndex'
import { loadStory } from './stories'

type CreateMemory = z.output<typeof CreateMemoryInputSchema>
type MemoryListQuery = z.output<typeof MemoryListQuerySchema>

async function loadItem(db: Db | Tx, access: ProjectAccess, id: string): Promise<MemoryRecord> {
  const [row] = await db
    .select(memoryColumns)
    .from(memoryItems)
    .where(and(eq(memoryItems.id, id), eq(memoryItems.projectId, access.project.id)))
    .limit(1)
  if (!row) throw notFound('Memory item')
  return row
}

async function storyOf(db: Db | Tx, row: MemoryRecord) {
  if (!row.storyId) return undefined
  const [s] = await db
    .select({ id: stories.id, number: stories.number, title: stories.title, assigneeId: stories.assigneeId })
    .from(stories)
    .where(eq(stories.id, row.storyId))
    .limit(1)
  return s
}

async function promotionOf(db: Db | Tx, access: ProjectAccess, row: MemoryRecord) {
  if (row.scope !== 'story') return undefined
  const [p] = await db
    .select({ id: memoryItems.id, status: memoryItems.status })
    .from(memoryItems)
    .where(and(eq(memoryItems.projectId, access.project.id), eq(memoryItems.promotedFromId, row.id)))
    .limit(1)
  return p
}

async function permissionsFor(db: Db | Tx, access: ProjectAccess, row: MemoryRecord) {
  return memoryActions(access, row, await storyOf(db, row), await promotionOf(db, access, row))
}

async function presentOne(db: Db | Tx, access: ProjectAccess, row: MemoryRecord): Promise<MemoryItem> {
  const [item] = await presentMemory(db, access, [row])
  return item
}

export function publishMemory(deps: ServiceDeps, projectKey: string, storyNumber: number | null, action: string, actorId: string | null): void {
  deps.bus.publish({ type: 'memory.changed', projectKey, storyNumber, action, actorId })
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

/** Below this cosine similarity a search result is not shown (keeps unrelated items out of a semantic search). */
const SEARCH_MIN_SCORE = 0.3

/**
 * Project (or all story) memory, optionally searched. With semantic search on for the project (and `index` given),
 * a search matches by meaning as well as by keywords — "currency precision" finds "amounts are stored in cents".
 */
export async function listProjectMemory(db: Db, user: AuthUser, key: string, query: MemoryListQuery, index?: MemoryIndexer): Promise<MemoryItem[]> {
  const access = await loadProjectAccess(db, user, key)
  const filters = [eq(memoryItems.projectId, access.project.id), eq(memoryItems.scope, query.scope)]
  if (query.status) filters.push(eq(memoryItems.status, query.status))
  if (query.kind) filters.push(eq(memoryItems.kind, query.kind))
  const q = query.q?.trim()
  const rows = await db
    .select(memoryColumns)
    .from(memoryItems)
    .where(and(...filters, ...(q ? [sql`${memoryItems.search} @@ websearch_to_tsquery('english', ${q})`] : [])))
    .orderBy(
      ...(q ? [desc(sql`ts_rank(${memoryItems.search}, websearch_to_tsquery('english', ${q}))`)] : []),
      desc(memoryItems.pinned),
      desc(memoryItems.updatedAt),
    )
    .limit(500)
  if (!q || !index || !(await index.usable(access.project.id, access.project.settings))) return presentMemory(db, access, rows)

  const statuses = query.status && query.status !== 'rejected' && query.status !== 'archived' ? [query.status] : (['accepted', 'proposed'] as const)
  const semantic = await index.similar(access.project.id, q, { limit: 40, scope: query.scope, statuses: [...statuses], minScore: SEARCH_MIN_SCORE })
  if (!semantic?.length) return presentMemory(db, access, rows)
  const order = fuseRankings([rows.map((r) => r.id), semantic.map((s) => s.id)])
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = order.filter((id) => !byId.has(id))
  if (missing.length) {
    // Same filters as the keyword search (kind, status, scope), minus the keyword match.
    for (const row of await db.select(memoryColumns).from(memoryItems).where(and(...filters, inArray(memoryItems.id, missing)))) byId.set(row.id, row)
  }
  return presentMemory(
    db,
    access,
    order.map((id) => byId.get(id)).filter((r): r is MemoryRecord => Boolean(r)),
  )
}

export async function listStoryMemory(db: Db, user: AuthUser, key: string, number: number): Promise<MemoryItem[]> {
  const access = await loadProjectAccess(db, user, key)
  const story = await loadStory(db, access, number)
  const rows = await db
    .select(memoryColumns)
    .from(memoryItems)
    .where(and(eq(memoryItems.projectId, access.project.id), eq(memoryItems.scope, 'story'), eq(memoryItems.storyId, story.id)))
    .orderBy(desc(memoryItems.createdAt))
    .limit(500)
  return presentMemory(db, access, rows)
}

// ─── Writing ─────────────────────────────────────────────────────────────────────────────────────

export async function addStoryMemory(deps: ServiceDeps, caller: Caller, key: string, number: number, input: CreateMemory): Promise<MemoryItem> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const story = await loadStory(deps.db, access, number)
  assertCan(access, 'memory.write', story)
  const run = input.runId ? await loadOwnedRun(deps.db, access, caller.user, input.runId) : null
  if (run && run.storyId !== story.id) throw conflict('That run is not on this story.')
  const row = await deps.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(memoryItems)
      .values({
        orgId: caller.user.orgId,
        projectId: access.project.id,
        scope: 'story',
        storyId: story.id,
        kind: input.kind,
        status: 'accepted',
        title: input.title,
        content: input.content,
        tags: input.tags,
        fileRefs: input.fileRefs,
        source: run ? 'run' : 'manual',
        runId: run?.id ?? null,
        createdBy: caller.user.id,
      })
      .returning(memoryColumns)
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'memory.added',
      resourceType: 'memory',
      resourceId: created.id,
      data: { key: `${access.project.key}-${number}`, scope: 'story', kind: input.kind, title: input.title, ...(run ? { runId: run.id, step: input.stepId ?? null } : {}) },
      via: caller.via,
    })
    return created
  })
  publishMemory(deps, access.project.key, number, 'added', caller.user.id)
  if (run) publishRunChanged(deps, access.project.key, number, run.id, caller.user.id)
  return presentOne(deps.db, access, row)
}

export async function addProjectMemory(deps: ServiceDeps, caller: Caller, key: string, input: CreateMemory): Promise<MemoryItem> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  // Curators add accepted items. An agent run's owner may propose one (a lead accepts it), so quick fixes started by
  // any developer can still leave project knowledge behind.
  const curator = can(access.actor, access.role, 'memory.curate')
  const run = input.runId ? await loadOwnedRun(deps.db, access, caller.user, input.runId) : null
  if (!curator && !run) assertCan(access, 'memory.curate')
  // A quick fix's (no story) item follows the project's quick-fix memory policy, like the memory the run captures.
  const status = projectMemoryStatus(curator, run, readProjectSettings(access.project.settings).memory)
  const curated = curator && status === 'accepted'
  const row = await deps.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(memoryItems)
      .values({
        orgId: caller.user.orgId,
        projectId: access.project.id,
        scope: 'project',
        kind: input.kind,
        status,
        title: input.title,
        content: input.content,
        tags: input.tags,
        fileRefs: input.fileRefs,
        pinned: curated ? (input.pinned ?? false) : false,
        source: run ? 'run' : 'manual',
        runId: run?.id ?? null,
        createdBy: caller.user.id,
        ...(curated ? { decidedBy: caller.user.id, decidedAt: new Date() } : {}),
      })
      .returning(memoryColumns)
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: status === 'accepted' ? 'memory.added' : 'memory.proposed',
      resourceType: 'memory',
      resourceId: created.id,
      data: { scope: 'project', kind: input.kind, title: input.title, ...(run ? { runId: run.id, step: input.stepId ?? null } : {}) },
      via: caller.via,
    })
    return created
  })
  publishMemory(deps, access.project.key, null, 'added', caller.user.id)
  if (run) publishRunChanged(deps, access.project.key, null, run.id, caller.user.id)
  return presentOne(deps.db, access, row)
}

/** Tell run views (the runs table, the run page) that a run's record changed. */
export function publishRunChanged(deps: ServiceDeps, projectKey: string, storyNumber: number | null, runId: string, actorId: string | null): void {
  deps.bus.publish({ type: 'work.changed', projectKey, storyNumber, kind: 'run', actorId, runId })
}

async function storyNumberOf(db: Db | Tx, row: MemoryRecord): Promise<number | null> {
  return (await storyOf(db, row))?.number ?? null
}

export async function updateMemory(deps: ServiceDeps, caller: Caller, key: string, id: string, input: UpdateMemoryInput): Promise<MemoryItem> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const row = await loadItem(deps.db, access, id)
  const perms = await permissionsFor(deps.db, access, row)
  const { pinned, ...fields } = input
  if (pinned !== undefined && pinned !== row.pinned && !perms.canPin) throw forbidden('Only a lead can pin accepted project memory.')
  if (Object.keys(fields).some((k) => fields[k as keyof typeof fields] !== undefined) && !perms.canEdit) throw forbidden()
  if (Object.values(input).every((v) => v === undefined)) throw badRequest('Nothing to update.')

  const updated = await deps.db.transaction(async (tx) => {
    const [next] = await tx
      .update(memoryItems)
      .set({ ...fields, ...(pinned !== undefined ? { pinned } : {}), updatedAt: new Date() })
      .where(eq(memoryItems.id, row.id))
      .returning(memoryColumns)
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: pinned !== undefined && Object.keys(fields).length === 0 ? (pinned ? 'memory.pinned' : 'memory.unpinned') : 'memory.updated',
      resourceType: 'memory',
      resourceId: row.id,
      data: { scope: row.scope, title: next.title, fields: Object.keys(input) },
      via: caller.via,
    })
    return next
  })
  publishMemory(deps, access.project.key, await storyNumberOf(deps.db, row), 'updated', caller.user.id)
  return presentOne(deps.db, access, updated)
}

/**
 * Propose a story item for project memory. A lead's promotion is accepted straight away; anyone else's waits for
 * a lead. Promoting again after a rejection reopens the same proposal.
 */
export async function promoteMemory(deps: ServiceDeps, caller: Caller, key: string, id: string): Promise<MemoryItem> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const row = await loadItem(deps.db, access, id)
  if (row.scope !== 'story') throw badRequest('Only story memory can be promoted to project memory.')
  const perms = await permissionsFor(deps.db, access, row)
  if (!perms.canPromote) throw conflict('This item is already in project memory, or you may not promote it.')
  const curate = can(access.actor, access.role, 'memory.curate')
  const status = curate ? 'accepted' : 'proposed'
  const decided = curate ? { decidedBy: caller.user.id, decidedAt: new Date() } : { decidedBy: null, decidedAt: null }

  const promoted = await deps.db.transaction(async (tx) => {
    const values = {
      kind: row.kind,
      status,
      title: row.title,
      content: row.content,
      tags: row.tags,
      fileRefs: row.fileRefs,
      decisionComment: null,
      ...decided,
    } as const
    const [created] = await tx
      .insert(memoryItems)
      .values({
        orgId: caller.user.orgId,
        projectId: access.project.id,
        scope: 'project',
        storyId: row.storyId,
        source: 'promotion',
        sourceRef: `promotion:${row.id}`,
        promotedFromId: row.id,
        createdBy: caller.user.id,
        ...values,
      })
      .onConflictDoUpdate({
        target: [memoryItems.projectId, memoryItems.source, memoryItems.sourceRef],
        targetWhere: sql`${memoryItems.sourceRef} is not null`,
        set: { ...values, createdBy: caller.user.id, updatedAt: new Date() },
      })
      .returning(memoryColumns)
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: curate ? 'memory.promoted' : 'memory.proposed',
      resourceType: 'memory',
      resourceId: created.id,
      data: { title: row.title, from: row.id },
      via: caller.via,
    })
    return created
  })
  publishMemory(deps, access.project.key, await storyNumberOf(deps.db, row), curate ? 'promoted' : 'proposed', caller.user.id)
  return presentOne(deps.db, access, promoted)
}

export async function decideMemory(deps: ServiceDeps, caller: Caller, key: string, id: string, input: DecideMemoryInput): Promise<MemoryItem> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  assertCan(access, 'memory.curate')
  const row = await loadItem(deps.db, access, id)
  if (row.scope !== 'project' || row.status !== 'proposed') throw conflict('Only a proposed project memory item can be accepted or rejected.')
  const decided = await deps.db.transaction(async (tx) => {
    const [next] = await tx
      .update(memoryItems)
      .set({
        status: input.accept ? 'accepted' : 'rejected',
        decidedBy: caller.user.id,
        decidedAt: new Date(),
        decisionComment: input.comment ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(memoryItems.id, row.id), eq(memoryItems.status, 'proposed')))
      .returning(memoryColumns)
    if (!next) throw conflict('Someone decided on this proposal already. Reload to see the result.')
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: input.accept ? 'memory.accepted' : 'memory.rejected',
      resourceType: 'memory',
      resourceId: row.id,
      data: { title: row.title, comment: input.comment ?? null },
      via: caller.via,
    })
    return next
  })
  publishMemory(deps, access.project.key, await storyNumberOf(deps.db, row), input.accept ? 'accepted' : 'rejected', caller.user.id)
  return presentOne(deps.db, access, decided)
}

export async function archiveMemory(deps: ServiceDeps, caller: Caller, key: string, id: string): Promise<MemoryItem> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const row = await loadItem(deps.db, access, id)
  if (!(await permissionsFor(deps.db, access, row)).canArchive) throw forbidden()
  const archived = await deps.db.transaction(async (tx) => {
    const [next] = await tx
      .update(memoryItems)
      .set({ status: 'archived', pinned: false, updatedAt: new Date() })
      .where(eq(memoryItems.id, row.id))
      .returning(memoryColumns)
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'memory.archived',
      resourceType: 'memory',
      resourceId: row.id,
      data: { scope: row.scope, title: row.title },
      via: caller.via,
    })
    return next
  })
  publishMemory(deps, access.project.key, await storyNumberOf(deps.db, row), 'archived', caller.user.id)
  return presentOne(deps.db, access, archived)
}
