// The run a VS Code client is acting for: it must belong to the project, and only the person running it may report
// for it (its changes, the memory it was given, the memory its agents write).

import { and, eq } from 'drizzle-orm'
import type { ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import type { Db, Tx } from '../db/client'
import { runs } from '../db/schema'
import { forbidden, notFound } from '../http'

export type RunRow = typeof runs.$inferSelect

export async function loadProjectRun(db: Db | Tx, access: ProjectAccess, runId: string): Promise<RunRow> {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.projectId, access.project.id)))
    .limit(1)
  if (!run) throw notFound('Run')
  return run
}

/** The run, when the caller is the person running it; otherwise 403 (404 when it is not in the project). */
export async function loadOwnedRun(db: Db | Tx, access: ProjectAccess, user: AuthUser, runId: string): Promise<RunRow> {
  const run = await loadProjectRun(db, access, runId)
  if (run.userId !== user.id) throw forbidden('Only the person running it can report for this run.')
  return run
}
