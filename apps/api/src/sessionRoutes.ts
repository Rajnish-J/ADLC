// Harness sessions and tasks (/api/v1): tasks under a story; starting a story or task from the web so it runs in the
// user's own VS Code harnesses (request → claim), cancelling it, deciding its approvals, the agent steps a harness
// works on, and the run's activity log. The run lifecycle is served by the orchestrator service (which also expires
// requests nobody picked up); permission checks live there and in the services.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  ApproveRunInputSchema,
  CancelRunInputSchema,
  ClaimRunInputSchema,
  CompleteStepInputSchema,
  NextStepQuerySchema,
  CreateTaskInputSchema,
  ReportRunEventsInputSchema,
  RequestRunInputSchema,
  RunEventsQuerySchema,
  SetStepSkillsInputSchema,
  SubmitPlanInputSchema,
  TaskParamsSchema,
  UpdateTaskInputSchema,
} from '@sdlc/contracts'
import { parse } from './http'
import { caller, KeyParams, StoryParams } from './routeKit'
import type { ServiceDeps } from './services/context'
import * as sessions from './services/sessions'
import { setStepSkills } from './services/stepSkills'
import * as tasks from './services/tasks'

const TaskParams = StoryParams.merge(TaskParamsSchema)
const ProjectRunParams = KeyParams.extend({ id: z.string().uuid() })
const RunIdParams = z.object({ id: z.string().uuid() })
const StepParams = KeyParams.extend({ id: z.string().uuid(), nodeId: z.string().min(1).max(200) })
const RunStepParams = ProjectRunParams.extend({ stepId: z.string().min(1).max(300) })
const STEP_LIMIT = { bodyLimit: 512 * 1024 }
const EVENTS_LIMIT = { bodyLimit: 2 * 1024 * 1024 }

export function registerSessionRoutes(app: FastifyInstance, deps: ServiceDeps): void {
  const { db } = deps

  // ─── Tasks under a story ───────────────────────────────────────────────────────────────────────
  app.get('/api/v1/projects/:key/stories/:number/tasks', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return tasks.listTasks(db, req.user, key, number)
  })

  app.post('/api/v1/projects/:key/stories/:number/tasks', async (req, reply) => {
    const { key, number } = parse(StoryParams, req.params)
    const task = await tasks.createTask(deps, caller(req), key, number, parse(CreateTaskInputSchema, req.body))
    return reply.code(201).send(task)
  })

  app.patch('/api/v1/projects/:key/stories/:number/tasks/:taskNumber', async (req) => {
    const { key, number, taskNumber } = parse(TaskParams, req.params)
    return tasks.updateTask(deps, caller(req), key, number, taskNumber, parse(UpdateTaskInputSchema, req.body))
  })

  app.delete('/api/v1/projects/:key/stories/:number/tasks/:taskNumber', async (req) => {
    const { key, number, taskNumber } = parse(TaskParams, req.params)
    return tasks.deleteTask(deps, caller(req), key, number, taskNumber)
  })

  // ─── Skills on a workflow step ─────────────────────────────────────────────────────────────────
  app.put('/api/v1/projects/:key/workflows/:id/nodes/:nodeId/skills', async (req) => {
    const { key, id, nodeId } = parse(StepParams, req.params)
    return setStepSkills(deps, caller(req), key, id, nodeId, parse(SetStepSkillsInputSchema, req.body))
  })

  // ─── Start in VS Code ──────────────────────────────────────────────────────────────────────────
  app.post('/api/v1/projects/:key/runs', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    const result = await sessions.requestRun(deps, caller(req), key, parse(RequestRunInputSchema, req.body))
    return reply.code(201).send(result)
  })

  app.post('/api/v1/projects/:key/runs/:id/cancel', async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    return sessions.cancelRun(deps, caller(req), key, id, parse(CancelRunInputSchema, req.body ?? {}))
  })

  // The extension: runs waiting for one of my windows, and claiming one.
  app.get('/api/v1/me/runs/pending', async (req) => sessions.pendingRuns(db, req.user))
  // The web's run monitor, and a reloaded VS Code window resuming the steps it was working on.
  app.get('/api/v1/me/runs/active', async (req) => sessions.activeRuns(db, req.user))

  app.post('/api/v1/runs/:id/claim', async (req) => {
    const { id } = parse(RunIdParams, req.params)
    return sessions.claimRun(deps, caller(req), id, parse(ClaimRunInputSchema, req.body))
  })

  // A person decides the plan or approval step an orchestrator-driven run is waiting on (web or VS Code).
  app.post('/api/v1/projects/:key/runs/:id/approval', async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    return sessions.approveRun(deps, caller(req), key, id, parse(ApproveRunInputSchema, req.body))
  })

  // ─── Agent steps, for the harness in VS Code (through the extension's SDLC tools) ─────────────
  app.get('/api/v1/projects/:key/runs/:id/steps/next', async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    return sessions.nextStep(deps, caller(req), key, id, parse(NextStepQuerySchema, req.query))
  })

  app.post('/api/v1/projects/:key/runs/:id/steps/:stepId/plan', STEP_LIMIT, async (req) => {
    const { key, id, stepId } = parse(RunStepParams, req.params)
    return sessions.submitPlan(deps, caller(req), key, id, stepId, parse(SubmitPlanInputSchema, req.body))
  })

  app.post('/api/v1/projects/:key/runs/:id/steps/:stepId/complete', STEP_LIMIT, async (req) => {
    const { key, id, stepId } = parse(RunStepParams, req.params)
    return sessions.completeStep(deps, caller(req), key, id, stepId, parse(CompleteStepInputSchema, req.body))
  })

  // ─── Run activity ──────────────────────────────────────────────────────────────────────────────
  app.post('/api/v1/projects/:key/runs/:id/events', EVENTS_LIMIT, async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    return sessions.reportRunEvents(deps, caller(req), key, id, parse(ReportRunEventsInputSchema, req.body))
  })

  app.get('/api/v1/projects/:key/runs/:id/events', async (req) => {
    const { key, id } = parse(ProjectRunParams, req.params)
    return sessions.listRunEvents(db, req.user, key, id, parse(RunEventsQuerySchema, req.query))
  })

}
