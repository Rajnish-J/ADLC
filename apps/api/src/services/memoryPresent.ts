// Memory rows → API shape, with the actions the caller may take on each item (computed from the shared rules, so
// the web app and the extension show exactly the buttons the API will accept).

import { and, eq, inArray, sql } from 'drizzle-orm'
import { can, storyKey, type MemoryItem } from '@sdlc/contracts'
import type { ProjectAccess } from '../access'
import type { Db, Tx } from '../db/client'
import { memoryItems, runMemoryReads, stories } from '../db/schema'
import { usersById } from '../dto'

export type MemoryRow = typeof memoryItems.$inferSelect
type StoryLite = { id: string; number: number; title: string; assigneeId: string | null }

/** Columns to read — never the generated search vector. */
export const memoryColumns = {
  id: memoryItems.id,
  orgId: memoryItems.orgId,
  projectId: memoryItems.projectId,
  scope: memoryItems.scope,
  storyId: memoryItems.storyId,
  kind: memoryItems.kind,
  status: memoryItems.status,
  title: memoryItems.title,
  content: memoryItems.content,
  tags: memoryItems.tags,
  pinned: memoryItems.pinned,
  fileRefs: memoryItems.fileRefs,
  source: memoryItems.source,
  sourceRef: memoryItems.sourceRef,
  promotedFromId: memoryItems.promotedFromId,
  runId: memoryItems.runId,
  createdBy: memoryItems.createdBy,
  decidedBy: memoryItems.decidedBy,
  decidedAt: memoryItems.decidedAt,
  decisionComment: memoryItems.decisionComment,
  createdAt: memoryItems.createdAt,
  updatedAt: memoryItems.updatedAt,
}
export type MemoryRecord = Omit<MemoryRow, 'search'>

export interface MemoryPermissions {
  canEdit: boolean
  canPromote: boolean
  canDecide: boolean
  canPin: boolean
  canArchive: boolean
}

/** What the caller may do with one item. `promotion` is the project item a story item was promoted into, if any. */
export function memoryActions(
  access: ProjectAccess,
  row: MemoryRecord,
  story: StoryLite | undefined,
  promotion: { status: MemoryRecord['status'] } | undefined,
): MemoryPermissions {
  const curate = can(access.actor, access.role, 'memory.curate')
  const writeStory = story ? can(access.actor, access.role, 'memory.write', story) : false
  const isAuthor = row.createdBy === access.actor.userId
  const live = row.status !== 'archived' && row.status !== 'rejected'
  const promotionOpen = promotion !== undefined && (promotion.status === 'proposed' || promotion.status === 'accepted')
  // The project profile's versions are kept by the platform: change the profile itself (Memory page), not this item.
  if (row.source === 'profile') return { canEdit: false, canPromote: false, canDecide: false, canPin: false, canArchive: false }
  if (row.scope === 'story') {
    return {
      canEdit: live && (curate || (isAuthor && writeStory)),
      canPromote: row.status === 'accepted' && !promotionOpen && (curate || writeStory),
      canDecide: false,
      canPin: false,
      canArchive: live && (curate || (isAuthor && writeStory)),
    }
  }
  return {
    canEdit: live && (curate || (isAuthor && row.status === 'proposed')),
    canPromote: false,
    canDecide: row.status === 'proposed' && curate,
    canPin: row.status === 'accepted' && curate,
    canArchive: live && (curate || (isAuthor && row.status === 'proposed')),
  }
}

/** Map rows to the API shape, loading the people, stories and promotions they reference in a few queries. */
export async function presentMemory(db: Db | Tx, access: ProjectAccess, rows: MemoryRecord[]): Promise<MemoryItem[]> {
  if (rows.length === 0) return []
  const people = await usersById(
    db,
    rows.flatMap((r) => [r.createdBy, r.decidedBy]),
  )
  const storyIds = [...new Set(rows.map((r) => r.storyId).filter((id): id is string => Boolean(id)))]
  const storyRows: StoryLite[] = storyIds.length
    ? await db
        .select({ id: stories.id, number: stories.number, title: stories.title, assigneeId: stories.assigneeId })
        .from(stories)
        .where(inArray(stories.id, storyIds))
    : []
  const storyById = new Map(storyRows.map((s) => [s.id, s]))

  const storyItemIds = rows.filter((r) => r.scope === 'story').map((r) => r.id)
  const promotions = storyItemIds.length
    ? await db
        .select({ id: memoryItems.id, status: memoryItems.status, from: memoryItems.promotedFromId })
        .from(memoryItems)
        .where(and(eq(memoryItems.projectId, access.project.id), inArray(memoryItems.promotedFromId, storyItemIds)))
    : []
  const promotionByFrom = new Map(promotions.map((p) => [p.from as string, p]))

  const uses = await db
    .select({ id: runMemoryReads.memoryItemId, runs: sql<number>`count(*)::int` })
    .from(runMemoryReads)
    .where(inArray(runMemoryReads.memoryItemId, rows.map((r) => r.id)))
    .groupBy(runMemoryReads.memoryItemId)
  const usesById = new Map(uses.map((u) => [u.id, u.runs]))

  return rows.map((r) => {
    const story = r.storyId ? storyById.get(r.storyId) : undefined
    const promotion = r.scope === 'story' ? promotionByFrom.get(r.id) : undefined
    return {
      id: r.id,
      scope: r.scope,
      storyKey: story ? storyKey(access.project.key, story.number) : null,
      storyNumber: story?.number ?? null,
      storyTitle: story?.title ?? null,
      kind: r.kind,
      status: r.status,
      title: r.title,
      content: r.content,
      tags: r.tags,
      pinned: r.pinned,
      fileRefs: r.fileRefs,
      source: r.source,
      promotedFromId: r.promotedFromId,
      promotion: promotion ? { id: promotion.id, status: promotion.status } : null,
      author: r.createdBy ? (people.get(r.createdBy) ?? null) : null,
      decidedBy: r.decidedBy ? (people.get(r.decidedBy) ?? null) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionComment: r.decisionComment,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      runId: r.runId,
      usedByRuns: usesById.get(r.id) ?? 0,
      actions: memoryActions(access, r, story, promotion),
    }
  })
}
