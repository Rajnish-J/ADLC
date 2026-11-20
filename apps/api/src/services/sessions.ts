// Harness sessions: a run started from the web that executes in the user's own VS Code. The orchestrator service
// (services/orchestrator) owns the lifecycle — request, claim, cancel, approvals, activity, expiry — and drives the
// run's LangGraph graph, handing each agent step to that step's harness. This module keeps the exports the routes
// and the chat assistant's tools call; `requestRun` and `claimRun` turn the orchestrator's answer into the StoryRun /
// RunLaunch shapes with the same presenters every other run view uses.

import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  ActiveRunsSchema,
  ApproveRunResultSchema,
  NextStepSchema,
  PendingRunsSchema,
  RunEventsPageSchema,
  StepAckSchema,
  runDeepLink,
  sameRepository,
  type ActiveRun,
  type ApproveRunInput,
  type CancelRunInput,
  type ApproveRunResult,
  type ClaimRunInput,
  type CompleteStepInput,
  type NextStep,
  type NextStepQuery,
  type PendingRuns,
  type ReportRunEventsInputSchema,
  type RequestRunInputSchema,
  type RequestRunResult,
  type RunEventsPage,
  type RunEventsQuery,
  type RunLaunch,
  type StepAck,
  type SubmitPlanInput,
} from '@sdlc/contracts'
import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import { loadProjectAccess } from '../access'
import { projectRepositories, runs, storyTasks } from '../db/schema'
import { usersById } from '../dto'
import { notFound } from '../http'
import { orchestrator, projectPath } from '../orchestrator/client'
import type { Caller, ServiceDeps } from './context'
import { toTasks } from './tasks'
import { clientsOf } from './settings'
import { taskRefs, toRunSummary } from './work'

type RequestRun = z.output<typeof RequestRunInputSchema>
type ReportEvents = z.output<typeof ReportRunEventsInputSchema>
type RunRow = typeof runs.$inferSelect

/** `storyNumber` is null for a quick fix started from a prompt. */
const RequestedSchema = z.object({
  runId: z.string().uuid(),
  projectKey: z.string(),
  storyNumber: z.number().int().nullable(),
  /** The window the run was sent to (null: whichever window takes it). Older orchestrators omit it. */
  clientId: z.string().nullable().optional(),
})
const ClaimedSchema = RequestedSchema.extend({
  driver: z.enum(['extension', 'orchestrator']),
  stepHarnesses: z.record(z.string()),
})
const CancelledSchema = z.object({ ok: z.literal(true), delivered: z.boolean() })
const LastSeqSchema = z.object({ lastSeq: z.number().int() })

async function runRow(db: Db, runId: string): Promise<RunRow> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  if (!row) throw notFound('Run')
  return row
}

async function summary(db: Db, run: RunRow, projectKey: string) {
  const people = await usersById(db, [run.userId, run.requestedBy])
  return toRunSummary(run, people, await taskRefs(db, [run], projectKey))
}

// ─── Request (web) ───────────────────────────────────────────────────────────────────────────────

/**
 * Start a story (or one of its tasks), or a quick fix described by a prompt, in the caller's VS Code. The run's harness — and every harness its steps are
 * pinned to — must be installed in one of the caller's online VS Code windows and allowed by the project.
 */
export async function requestRun(deps: ServiceDeps, caller: Caller, key: string, input: RequestRun): Promise<RequestRunResult> {
  const repoClientIds = await windowsWithRepo(deps.db, caller.user, key)
  const r = await orchestrator().call(caller, 'POST', projectPath(key, 'runs'), RequestedSchema, { body: { ...input, repoClientIds } })
  const run = await runRow(deps.db, r.runId)
  const clientId = r.clientId ?? null
  return {
    run: { ...(await summary(deps.db, run, r.projectKey)), steps: [] },
    deepLink: runDeepLink(r.runId, r.projectKey, r.storyNumber),
    clientId,
    // Sent to a window that already has the repo open: its live connection delivers the run, so the browser doesn't
    // open a vscode:// link (which can land in — or open — a different window).
    delivery: clientId && repoClientIds.includes(clientId) ? 'window' : 'link',
  }
}

/**
 * The caller's online VS Code windows that have the project's repository open (newest first), matched on the
 * window's git origin. A blank project's DB workspace (`workspace://…`) has no remote, so nothing matches it.
 */
async function windowsWithRepo(db: Db, user: AuthUser, key: string): Promise<string[]> {
  try {
    const { project } = await loadProjectAccess(db, user, key)
    const repos = await db.select({ remoteUrl: projectRepositories.remoteUrl }).from(projectRepositories).where(eq(projectRepositories.projectId, project.id))
    const urls = [...repos.map((r) => r.remoteUrl), project.repoUrl].filter((u): u is string => !!u && !u.startsWith('workspace://'))
    if (urls.length === 0) return []
    const clients = await clientsOf(db, user.id)
    return clients.filter((c) => c.online && urls.some((u) => sameRepository(c.workspace?.remoteUrl, u))).map((c) => c.clientId)
  } catch {
    // The orchestrator checks access itself and reports a missing project properly.
    return []
  }
}

// ─── Claim (extension) ───────────────────────────────────────────────────────────────────────────

/** Runs of mine still waiting for a VS Code window — a reconnecting extension catches up with these. */
export async function pendingRuns(_db: Db, user: AuthUser): Promise<PendingRuns> {
  return orchestrator().call({ user }, 'GET', '/api/v1/me/runs/pending', PendingRunsSchema)
}

/** My runs that have not ended (any project), with the agent steps waiting for a harness. */
export async function activeRuns(_db: Db, user: AuthUser): Promise<ActiveRun[]> {
  return orchestrator().call({ user }, 'GET', '/api/v1/me/runs/active', ActiveRunsSchema)
}

/**
 * A VS Code window takes a requested run; for an orchestrator-driven run this starts its graph. Idempotent for the
 * same window; another window gets 409, and a request that waited too long gets 410.
 */
export async function claimRun(deps: ServiceDeps, caller: Caller, runId: string, input: ClaimRunInput): Promise<RunLaunch> {
  const c = await orchestrator().call(caller, 'POST', `/api/v1/runs/${encodeURIComponent(runId)}/claim`, ClaimedSchema, { body: input })
  const run = await runRow(deps.db, runId)
  const storyKey = c.storyNumber != null ? `${c.projectKey}-${c.storyNumber}` : null
  const [taskRow] = run.taskId && storyKey ? await deps.db.select().from(storyTasks).where(eq(storyTasks.id, run.taskId)).limit(1) : []
  const [task] = taskRow && storyKey && c.storyNumber != null ? await toTasks(deps.db, [taskRow], storyKey, c.storyNumber) : [null]
  return {
    run: { ...(await summary(deps.db, run, c.projectKey)), steps: [] },
    projectKey: c.projectKey,
    storyNumber: c.storyNumber,
    storyKey,
    task: task ?? null,
    prompt: run.prompt ?? null,
    workflowId: run.workflowId ?? '',
    workflowVersion: run.workflowVersion ?? 0,
    engine: run.engine ?? 'copilot',
    engineModel: run.engineModel,
    driver: c.driver,
    stepHarnesses: c.stepHarnesses,
    workflowSpec: run.specSnapshot ?? null,
  }
}

// ─── Cancel / approve (web, VS Code) ─────────────────────────────────────────────────────────────

/** Cancel a run. The run's owner, or a lead, may cancel. */
export async function cancelRun(_deps: ServiceDeps, caller: Caller, key: string, runId: string, input: CancelRunInput = {}): Promise<{ ok: true; delivered: boolean }> {
  return orchestrator().call(caller, 'POST', projectPath(key, 'runs', runId, 'cancel'), CancelledSchema, { body: input })
}

/** Decide the plan or approval step an orchestrator-driven run is waiting on. The run's owner, or a lead. */
export async function approveRun(_deps: ServiceDeps, caller: Caller, key: string, runId: string, input: ApproveRunInput): Promise<ApproveRunResult> {
  return orchestrator().call(caller, 'POST', projectPath(key, 'runs', runId, 'approval'), ApproveRunResultSchema, { body: input })
}

// ─── Agent steps, for the harness in VS Code ─────────────────────────────────────────────────────

/** Long-poll for the harness's next step (`waiting` / `handoff` / `done` when there is none). */
export async function nextStep(_deps: ServiceDeps, caller: Caller, key: string, runId: string, query: NextStepQuery): Promise<NextStep> {
  const wait = Math.min(50, Math.max(0, Number(query.wait ?? 25)))
  return orchestrator().call(caller, 'GET', projectPath(key, 'runs', runId, 'steps', 'next'), NextStepSchema, {
    query: { harness: query.harness, clientId: query.clientId, wait },
    timeoutMs: (wait + 15) * 1000,
  })
}

export async function submitPlan(_deps: ServiceDeps, caller: Caller, key: string, runId: string, stepId: string, input: SubmitPlanInput): Promise<StepAck> {
  return orchestrator().call(caller, 'POST', projectPath(key, 'runs', runId, 'steps', stepId, 'plan'), StepAckSchema, { body: input })
}

export async function completeStep(_deps: ServiceDeps, caller: Caller, key: string, runId: string, stepId: string, input: CompleteStepInput): Promise<StepAck> {
  return orchestrator().call(caller, 'POST', projectPath(key, 'runs', runId, 'steps', stepId, 'complete'), StepAckSchema, { body: input })
}

// ─── Activity events ─────────────────────────────────────────────────────────────────────────────

/** The extension running the run appends its activity; repeated batches are ignored by (run, seq). */
export async function reportRunEvents(_deps: ServiceDeps, caller: Caller, key: string, runId: string, input: ReportEvents): Promise<{ lastSeq: number }> {
  return orchestrator().call(caller, 'POST', projectPath(key, 'runs', runId, 'events'), LastSeqSchema, { body: input })
}

export async function listRunEvents(_db: Db, user: AuthUser, key: string, runId: string, query: Required<RunEventsQuery>): Promise<RunEventsPage> {
  return orchestrator().call({ user }, 'GET', projectPath(key, 'runs', runId, 'events'), RunEventsPageSchema, {
    query: { after: query.after, limit: query.limit },
  })
}
