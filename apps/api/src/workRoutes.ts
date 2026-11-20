// Code activity on a story (/api/v1): the VS Code extension reports working state, commits and agent runs; the
// web app and the extension read them back. Permission checks live in the work service.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  GenerateRunInsightInputSchema,
  ReportCommitsInputSchema,
  ReportRunChangesInputSchema,
  ReportRunInputSchema,
  ReportWorkspaceInputSchema,
  RunFeedbackInputSchema,
  RunListQuerySchema,
  RunMemoryHelpfulInputSchema,
  RunStatsQuerySchema,
} from '@sdlc/contracts'
import type { Config } from './config'
import { parse } from './http'
import { caller, KeyParams, StoryParams } from './routeKit'
import type { ServiceDeps } from './services/context'
import * as records from './services/runRecords'
import { createRunInsights } from './services/runInsights'
import * as work from './services/work'

/** Reports carry diff text, so allow more than the 1 MB default body size. */
const REPORT_LIMIT = { bodyLimit: 6 * 1024 * 1024 }

const RunParams = StoryParams.extend({ runId: z.string().min(1).max(200) })
const CommitParams = StoryParams.extend({ sha: z.string().regex(/^[0-9a-f]{7,64}$/i) })
const WorkspaceParams = StoryParams.extend({ userId: z.string().uuid() })
const ProjectRunParams = KeyParams.extend({ id: z.string().uuid() })
const RunMemoryParams = ProjectRunParams.extend({ itemId: z.string().uuid() })

export function registerWorkRoutes(app: FastifyInstance, deps: ServiceDeps, config: Config): void {
  const { db } = deps
  const insights = createRunInsights(config)

  app.get('/api/v1/projects/:key/stories/:number/work', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return work.storyWork(db, req.user, key, number)
  })

  app.put('/api/v1/projects/:key/stories/:number/workspace', REPORT_LIMIT, async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return work.reportWorkspace(deps, caller(req), key, number, parse(ReportWorkspaceInputSchema, req.body))
  })

  app.delete('/api/v1/projects/:key/stories/:number/workspace', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return work.clearWorkspace(deps, caller(req), key, number)
  })

  app.get('/api/v1/projects/:key/stories/:number/workspace/:userId/diff', async (req) => {
    const { key, number, userId } = parse(WorkspaceParams, req.params)
    return work.workspaceDiff(db, req.user, key, number, userId)
  })

  app.post('/api/v1/projects/:key/stories/:number/commits', REPORT_LIMIT, async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return work.reportCommits(deps, caller(req), key, number, parse(ReportCommitsInputSchema, req.body))
  })

  app.get('/api/v1/projects/:key/stories/:number/commits/:sha/diff', async (req) => {
    const { key, number, sha } = parse(CommitParams, req.params)
    return work.commitDiff(db, req.user, key, number, sha)
  })

  app.put('/api/v1/projects/:key/stories/:number/runs/:runId', REPORT_LIMIT, async (req) => {
    const { key, number, runId } = parse(RunParams, req.params)
    return work.reportRun(deps, caller(req), key, number, runId, parse(ReportRunInputSchema, req.body))
  })

  // Project-wide runs (every story, every developer) with gate tallies; one run with its steps and evaluations.
  app.get('/api/v1/projects/:key/runs', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return work.projectRuns(db, req.user, key, parse(RunListQuerySchema, req.query))
  })

  /** Totals and charts for the Runs dashboard (before `/runs/:id`, which only matches uuids anyway). */
  app.get('/api/v1/projects/:key/runs/stats', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return records.runStats(db, req.user, key, parse(RunStatsQuerySchema, req.query))
  })

  app.get('/api/v1/projects/:key/runs/:id', async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    const detail = await work.projectRun(db, req.user, key, id)
    return { ...detail, insight: await insights.status(db, detail) }
  })

  /** What the run changed, against the commit it started from — reported by the VS Code window running it. */
  app.put('/api/v1/projects/:key/runs/:id/changes', REPORT_LIMIT, async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    return records.reportRunChanges(deps, caller(req), key, id, parse(ReportRunChangesInputSchema, req.body))
  })

  app.get('/api/v1/projects/:key/runs/:id/diff', async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    return records.runDiff(db, req.user, key, id)
  })

  app.put('/api/v1/projects/:key/runs/:id/feedback', async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    return records.setRunFeedback(deps, caller(req), key, id, parse(RunFeedbackInputSchema, req.body))
  })

  app.put('/api/v1/projects/:key/runs/:id/memory/:itemId/helpful', async (req) => {
    const { key, id, itemId } = parse(RunMemoryParams, req.params)
    return records.setMemoryHelpful(deps, caller(req), key, id, itemId, parse(RunMemoryHelpfulInputSchema, req.body))
  })

  /** Write (or, with `force`, rewrite) the AI summary of an ended run. */
  app.post('/api/v1/projects/:key/runs/:id/insights', async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    const { force } = parse(GenerateRunInsightInputSchema, req.body ?? {})
    const detail = await work.projectRun(db, req.user, key, id)
    return insights.generate(db, req.user, detail, force)
  })
}
