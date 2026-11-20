// Database rows → API response shapes (@sdlc/contracts). Story responses carry `actions` computed with the
// shared rules, so both clients show exactly the buttons the API will accept.

import { and, desc, inArray, isNull, ne } from 'drizzle-orm'
import {
  allowedTransitions,
  can,
  canPickUp,
  storyKey,
  type Actor,
  type AuditEntry,
  type ProjectRole,
  type RunSummary,
  type Story,
  type StoryExternal,
  type User,
} from '@sdlc/contracts'
import type { Db, Tx } from './db/client'
import { auditLog, runs, stories, users } from './db/schema'
import { storyExternalLinks } from './db/boardsSchema'

export type StoryRow = typeof stories.$inferSelect
export type AuditRow = typeof auditLog.$inferSelect
export type UserRow = typeof users.$inferSelect

export function toUser(u: Pick<UserRow, 'id' | 'email' | 'displayName' | 'orgRole'>): User {
  return { id: u.id, email: u.email, displayName: u.displayName, orgRole: u.orgRole }
}

/** Load the users referenced by `ids` in one query. */
export async function usersById(db: Db | Tx, ids: Iterable<string | null>): Promise<Map<string, User>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))]
  if (unique.length === 0) return new Map()
  const rows = await db.select().from(users).where(inArray(users.id, unique))
  return new Map(rows.map((r) => [r.id, toUser(r)]))
}

export function toStory(
  row: StoryRow,
  projectKey: string,
  people: Map<string, User>,
  actor: Actor,
  role: ProjectRole | undefined,
  external: StoryExternal | null = null,
  latestRun: RunSummary | null = null,
): Story {
  const ownership = { status: row.status, assigneeId: row.assigneeId }
  const createdBy = people.get(row.createdBy)
  if (!createdBy) throw new Error(`Story ${row.id}: creator ${row.createdBy} not loaded`)
  return {
    id: row.id,
    projectKey,
    number: row.number,
    key: storyKey(projectKey, row.number),
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    status: row.status,
    priority: row.priority,
    isBlocked: row.isBlocked,
    blockedReason: row.blockedReason,
    labels: row.labels,
    dueDate: row.dueDate,
    rank: row.rank,
    external,
    assignee: row.assigneeId ? (people.get(row.assigneeId) ?? null) : null,
    createdBy,
    latestRun,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    actions: {
      canEdit: can(actor, role, 'story.edit', ownership),
      canPickUp: canPickUp(actor, role, ownership),
      canAssign: can(actor, role, 'story.assign'),
      canAddMemory: can(actor, role, 'memory.write', ownership),
      canReportWork: can(actor, role, 'work.report', ownership),
      transitions: allowedTransitions(actor, role, ownership).map((t) => ({ to: t.to, label: t.label })),
    },
  }
}

/** Map several story rows, loading every referenced user once. */
export async function toStories(
  db: Db | Tx,
  rows: StoryRow[],
  projectKey: string,
  actor: Actor,
  role: ProjectRole | undefined,
): Promise<Story[]> {
  const people = await usersById(
    db,
    rows.flatMap((r) => [r.createdBy, r.assigneeId]),
  )
  const ids = rows.map((r) => r.id)
  const [links, latest] = await Promise.all([externalLinks(db, ids), latestStoryRuns(db, ids)])
  return rows.map((r) => toStory(r, projectKey, people, actor, role, links.get(r.id) ?? null, latest.get(r.id) ?? null))
}

/**
 * Each story's latest run on the story itself (task runs show on their task), in one query: the workflow it was
 * started with is how the board shows which workflow a story is worked with. Expired requests never ran, so skip them.
 */
async function latestStoryRuns(db: Db | Tx, storyIds: string[]): Promise<Map<string, RunSummary>> {
  if (storyIds.length === 0) return new Map()
  const rows = await db
    .selectDistinctOn([runs.storyId], {
      storyId: runs.storyId,
      id: runs.id,
      status: runs.status,
      engine: runs.engine,
      startedAt: runs.startedAt,
      workflowId: runs.workflowId,
      workflowName: runs.workflowName,
    })
    .from(runs)
    .where(and(inArray(runs.storyId, storyIds), isNull(runs.taskId), ne(runs.status, 'expired')))
    .orderBy(runs.storyId, desc(runs.startedAt))
  return new Map(
    rows.map((r) => [
      r.storyId as string,
      { id: r.id, status: r.status, engine: r.engine, startedAt: r.startedAt.toISOString(), workflowId: r.workflowId, workflowName: r.workflowName },
    ]),
  )
}

/** The Azure Boards work items the given stories are synced from, in one query. */
async function externalLinks(db: Db | Tx, storyIds: string[]): Promise<Map<string, StoryExternal>> {
  if (storyIds.length === 0) return new Map()
  const rows = await db.select().from(storyExternalLinks).where(inArray(storyExternalLinks.storyId, storyIds))
  return new Map(
    rows.map((r) => [r.storyId, { provider: 'azure-boards' as const, id: r.externalId, url: r.url, type: r.itemType, state: r.state }]),
  )
}

/** Map audit rows, loading every actor once. */
export async function toAuditEntries(db: Db | Tx, rows: AuditRow[]): Promise<AuditEntry[]> {
  const people = await usersById(
    db,
    rows.map((r) => r.actorUserId),
  )
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor: r.actorUserId ? (people.get(r.actorUserId) ?? null) : null,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    data: r.data,
    via: r.via,
    createdAt: r.createdAt.toISOString(),
  }))
}
