// Calls from the orchestrator service back into the gateway (never from browsers or VS Code): authenticated by the
// shared internal token instead of a user. `/internal/*` is skipped by the user sign-in hook (see auth.ts).

import { timingSafeEqual } from 'crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Config } from '../config'
import { projects, runChanges, runSteps, runs, stories, users } from '../db/schema'
import { HttpError, parse } from '../http'
import type { ServiceDeps } from '../services/context'
import { captureRunMemory } from '../services/memoryCapture'
import { transitionStory } from '../services/stories'
import { INTERNAL_TOKEN_HEADER } from './client'

const RunParams = z.object({ id: z.string().uuid() })

function assertInternal(req: FastifyRequest, token: string): void {
  const sent = Buffer.from(String(req.headers[INTERNAL_TOKEN_HEADER] ?? ''))
  const expected = Buffer.from(token)
  if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
    throw new HttpError(401, 'unauthorized', 'Internal endpoint.')
  }
}

export function registerInternalRoutes(app: FastifyInstance, deps: ServiceDeps, config: Config): void {
  /**
   * An orchestrator-driven run ended: capture its memory (gate failures, rejected plans, the run summary) the same
   * way reported runs are captured. Idempotent — every captured item is keyed by its source.
   */
  app.post('/internal/runs/:id/finished', async (req) => {
    assertInternal(req, config.ORCHESTRATOR_TOKEN)
    const { id } = parse(RunParams, req.params)
    const [found] = await deps.db
      .select({ run: runs, projectKey: projects.key, storyNumber: stories.number })
      .from(runs)
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .leftJoin(stories, eq(stories.id, runs.storyId))
      .where(eq(runs.id, id))
      .limit(1)
    if (!found) throw new HttpError(404, 'not_found', 'Run not found.')
    const { run } = found
    const steps = await deps.db.select().from(runSteps).where(eq(runSteps.runId, id))
    // What VS Code reported the run changed (with line counts); a quick fix's items are proposed to project memory.
    const [changes] = await deps.db.select({ files: runChanges.files }).from(runChanges).where(eq(runChanges.runId, id)).limit(1)
    const captured = await deps.db.transaction((tx) =>
      captureRunMemory(
        tx,
        { orgId: run.orgId, projectId: run.projectId, storyId: run.storyId, userId: run.userId },
        { id: run.id, workflowName: run.workflowName, status: run.status, changedFiles: run.changedFiles, prompt: run.prompt },
        steps.map((s) => ({
          stepId: s.stepId,
          kind: s.kind,
          label: s.label,
          status: s.status,
          seq: s.seq,
          output: s.output,
          gatePass: s.gatePass,
          gateReason: s.gateReason,
          approval: s.approval ?? null,
        })),
        changes?.files ?? null,
      ),
    )
    if (captured > 0) {
      deps.bus.publish({ type: 'memory.changed', projectKey: found.projectKey, storyNumber: found.storyNumber ?? null, action: 'captured', actorId: null })
    }
    // A completed run that changed code proposes an updated project profile (debounced; skipped without changes).
    deps.profiles?.runEnded(run.id)
    const movedToReview = await moveStoryToReview(deps, found.projectKey, found.storyNumber ?? null, run, (msg) => req.log.warn(msg))
    return { ok: true, captured, movedToReview }
  })
}

/**
 * A story run that completed (its last step is the Merge approval) leaves the story In review, as the person who
 * started the run — the merge itself stays theirs. Task runs and quick fixes don't move the story. Best-effort: a
 * story someone already moved, or a transition the starter may not make, is left alone.
 */
async function moveStoryToReview(
  deps: ServiceDeps,
  projectKey: string,
  storyNumber: number | null,
  run: typeof runs.$inferSelect,
  warn: (msg: string) => void,
): Promise<boolean> {
  if (run.status !== 'completed' || !run.storyId || !run.userId || run.taskId || storyNumber === null) return false
  const [story] = await deps.db.select({ status: stories.status }).from(stories).where(eq(stories.id, run.storyId)).limit(1)
  if (story?.status !== 'in_progress') return false
  const [user] = await deps.db
    .select({ id: users.id, orgId: users.orgId, email: users.email, displayName: users.displayName, orgRole: users.orgRole })
    .from(users)
    .where(eq(users.id, run.userId))
    .limit(1)
  if (!user) return false
  try {
    await transitionStory(deps, { user, via: 'orchestrator' }, projectKey, storyNumber, { to: 'in_review' })
    return true
  } catch (err) {
    warn(`Run ${run.id}: could not move ${projectKey}-${storyNumber} to In review: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
