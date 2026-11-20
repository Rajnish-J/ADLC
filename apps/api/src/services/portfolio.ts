// Portfolio: one row per project the caller can see — story counts by status, what is blocked, overdue or
// ready-but-unassigned, and how many runs are in flight. Read-only; feeds the chat's Portfolio assistant.

import { and, count, eq, inArray, isNull, lt, ne } from 'drizzle-orm'
import { STORY_STATUSES, type PortfolioProject } from '@sdlc/contracts'
import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import { runs, stories } from '../db/schema'
import { listProjects } from './projects'

const ACTIVE_RUN_STATUSES = ['requested', 'queued', 'running', 'awaiting_approval'] as const

export async function portfolio(db: Db, user: AuthUser): Promise<PortfolioProject[]> {
  const projects = await listProjects(db, user)
  if (projects.length === 0) return []
  const ids = projects.map((p) => p.id)
  const today = new Date().toISOString().slice(0, 10)

  const [blocked, overdue, unassigned, active] = await Promise.all([
    db
      .select({ projectId: stories.projectId, n: count() })
      .from(stories)
      .where(and(inArray(stories.projectId, ids), eq(stories.isBlocked, true), ne(stories.status, 'done')))
      .groupBy(stories.projectId),
    db
      .select({ projectId: stories.projectId, n: count() })
      .from(stories)
      .where(and(inArray(stories.projectId, ids), lt(stories.dueDate, today), ne(stories.status, 'done')))
      .groupBy(stories.projectId),
    db
      .select({ projectId: stories.projectId, n: count() })
      .from(stories)
      .where(and(inArray(stories.projectId, ids), eq(stories.status, 'ready'), isNull(stories.assigneeId)))
      .groupBy(stories.projectId),
    db
      .select({ projectId: runs.projectId, n: count() })
      .from(runs)
      .where(and(inArray(runs.projectId, ids), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
      .groupBy(runs.projectId),
  ])
  const index = (rows: { projectId: string | null; n: number }[]) => new Map(rows.map((r) => [r.projectId, Number(r.n)]))
  const [b, o, u, a] = [index(blocked), index(overdue), index(unassigned), index(active)]

  return projects.map((p) => {
    const byStatus = Object.fromEntries(STORY_STATUSES.map((s) => [s, p.storyCounts[s] ?? 0]))
    return {
      key: p.key,
      name: p.name,
      myRole: p.myRole,
      stories: {
        total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
        byStatus,
        blocked: b.get(p.id) ?? 0,
        overdue: o.get(p.id) ?? 0,
        unassignedReady: u.get(p.id) ?? 0,
      },
      activeRuns: a.get(p.id) ?? 0,
    }
  })
}
