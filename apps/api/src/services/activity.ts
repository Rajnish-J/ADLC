// One story's history for its Activity tab: everything the audit log recorded about the story itself, its memory
// items and the agent runs reported against it — newest first. Any project member may read it; the project-wide
// log stays lead-only.

import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import type { AuditEntry } from '@sdlc/contracts'
import { loadProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import { auditLog, memoryItems, runs } from '../db/schema'
import { toAuditEntries } from '../dto'
import { loadStory } from './stories'

export interface ActivityPage {
  /** Only entries older than this audit id (the last id of the previous page). */
  before?: number
  limit: number
}

export async function storyActivity(db: Db, user: AuthUser, key: string, number: number, page: ActivityPage): Promise<AuditEntry[]> {
  const access = await loadProjectAccess(db, user, key)
  const story = await loadStory(db, access, number)

  const memoryIds = db.select({ id: sql<string>`${memoryItems.id}::text` }).from(memoryItems).where(eq(memoryItems.storyId, story.id))
  const runIds = db.select({ id: sql<string>`${runs.id}::text` }).from(runs).where(eq(runs.storyId, story.id))

  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.projectId, access.project.id),
        or(
          and(eq(auditLog.resourceType, 'story'), eq(auditLog.resourceId, story.id)),
          and(eq(auditLog.resourceType, 'memory'), inArray(auditLog.resourceId, memoryIds)),
          and(eq(auditLog.resourceType, 'run'), inArray(auditLog.resourceId, runIds)),
        ),
        page.before ? lt(auditLog.id, page.before) : undefined,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(page.limit)
  return toAuditEntries(db, rows)
}
