// Code activity reported by the VS Code extension while a developer works on a story: their live working state,
// the commits on the story branch, and the agent runs started on the story. Reports are idempotent — the
// extension may resend after a reconnect — and only status changes are audited (snapshots would flood the log).

import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import {
  taskKey,
  type EvaluationResult,
  type Patch,
  type ProjectRun,
  type ProjectRunDetail,
  type ReportCommitsInputSchema,
  type ReportRunInputSchema,
  type ReportWorkspaceInputSchema,
  type RunListQuerySchema,
  type RunTaskRef,
  type StoryRun,
  type StoryRunStep,
  type StoryWork,
  type User,
} from '@sdlc/contracts'
import type { z } from 'zod'
import { assertCan, loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db, Tx } from '../db/client'
import { runEvaluations, runSteps, runs, stories, storyCommits, storyTasks, storyWorkspaces } from '../db/schema'
import { usersById } from '../dto'
import { conflict, notFound } from '../http'
import type { Caller, ServiceDeps } from './context'
import { captureRunMemory } from './memoryCapture'
import { runDetailRecords, runIterations, runListExtras, type RunListExtras } from './runRecords'
import { loadStory } from './stories'

type ReportWorkspace = z.output<typeof ReportWorkspaceInputSchema>
type ReportCommits = z.output<typeof ReportCommitsInputSchema>
type ReportRun = z.output<typeof ReportRunInputSchema>

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function reportableStory(deps: ServiceDeps, caller: Caller, key: string, number: number) {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const story = await loadStory(deps.db, access, number)
  assertCan(access, 'work.report', story)
  return { access, story }
}

export function publishWork(
  deps: ServiceDeps,
  access: ProjectAccess,
  number: number,
  kind: 'workspace' | 'commits' | 'run',
  actorId: string | null,
  runId?: string,
): void {
  deps.bus.publish({ type: 'work.changed', projectKey: access.project.key, storyNumber: number, kind, actorId, ...(runId ? { runId } : {}) })
}

const sum = (files: { additions: number; deletions: number }[]) => ({
  additions: files.reduce((n, f) => n + f.additions, 0),
  deletions: files.reduce((n, f) => n + f.deletions, 0),
})

// ─── Live working state ──────────────────────────────────────────────────────────────────────────

export async function reportWorkspace(deps: ServiceDeps, caller: Caller, key: string, number: number, input: ReportWorkspace): Promise<{ ok: true }> {
  const { access, story } = await reportableStory(deps, caller, key, number)
  const values = {
    branch: input.branch,
    headSha: input.headSha,
    ahead: input.ahead,
    behind: input.behind,
    files: input.files,
    ...sum(input.files),
    patch: input.patch,
    patchTruncated: input.patchTruncated,
    updatedAt: new Date(),
  }
  await deps.db
    .insert(storyWorkspaces)
    .values({ projectId: access.project.id, storyId: story.id, userId: caller.user.id, ...values })
    .onConflictDoUpdate({ target: [storyWorkspaces.storyId, storyWorkspaces.userId], set: values })
  publishWork(deps, access, number, 'workspace', caller.user.id)
  return { ok: true }
}

/** The developer left the story branch (or stopped tracking): drop their live snapshot. */
export async function clearWorkspace(deps: ServiceDeps, caller: Caller, key: string, number: number): Promise<{ ok: true }> {
  const { access, story } = await reportableStory(deps, caller, key, number)
  const removed = await deps.db
    .delete(storyWorkspaces)
    .where(and(eq(storyWorkspaces.storyId, story.id), eq(storyWorkspaces.userId, caller.user.id)))
    .returning({ userId: storyWorkspaces.userId })
  if (removed.length) publishWork(deps, access, number, 'workspace', caller.user.id)
  return { ok: true }
}

// ─── Commits ─────────────────────────────────────────────────────────────────────────────────────

export async function reportCommits(deps: ServiceDeps, caller: Caller, key: string, number: number, input: ReportCommits): Promise<{ added: number }> {
  const { access, story } = await reportableStory(deps, caller, key, number)
  const added = await deps.db.transaction(async (tx) => {
    const fresh: { sha: string; message: string }[] = []
    for (const c of input.commits) {
      const values = {
        branch: c.branch,
        message: c.message,
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        committedAt: new Date(c.committedAt),
        files: c.files,
        ...sum(c.files),
        patch: c.patch,
        patchTruncated: c.patchTruncated,
      }
      const [row] = await tx
        .insert(storyCommits)
        .values({ projectId: access.project.id, storyId: story.id, sha: c.sha.toLowerCase(), reportedBy: caller.user.id, ...values })
        .onConflictDoUpdate({ target: [storyCommits.storyId, storyCommits.sha], set: values })
        .returning({ inserted: sql<boolean>`(xmax = 0)` })
      if (row?.inserted) fresh.push({ sha: c.sha.slice(0, 12), message: c.message.split('\n')[0].slice(0, 120) })
    }
    if (fresh.length) {
      await writeAudit(tx, {
        orgId: caller.user.orgId,
        projectId: access.project.id,
        actorUserId: caller.user.id,
        action: 'commits.reported',
        resourceType: 'story',
        resourceId: story.id,
        data: { key: `${access.project.key}-${number}`, count: fresh.length, branch: input.commits[0].branch, commits: fresh.slice(0, 10) },
        via: caller.via,
      })
    }
    return fresh.length
  })
  publishWork(deps, access, number, 'commits', caller.user.id)
  return { added }
}

// ─── Agent runs ──────────────────────────────────────────────────────────────────────────────────

const toDate = (iso: string | null) => (iso ? new Date(iso) : null)

/**
 * Upsert a whole run snapshot (steps included). Audits only what changed in status — started, finished, an
 * approval decided — and captures memory from it (see memoryCapture).
 */
export async function reportRun(
  deps: ServiceDeps,
  caller: Caller,
  key: string,
  number: number,
  clientRunId: string,
  input: ReportRun,
): Promise<{ id: string }> {
  const { access, story } = await reportableStory(deps, caller, key, number)
  const changedFiles = [...new Set(input.steps.flatMap((s) => s.changedFiles))].slice(0, 2000)
  const tokensIn = input.steps.reduce((n, s) => n + (s.tokensIn ?? 0), 0)
  const tokensOut = input.steps.reduce((n, s) => n + (s.tokensOut ?? 0), 0)

  const result = await deps.db.transaction(async (tx) => {
    const [task] = input.taskNumber
      ? await tx
          .select({ id: storyTasks.id })
          .from(storyTasks)
          .where(and(eq(storyTasks.storyId, story.id), eq(storyTasks.number, input.taskNumber)))
          .limit(1)
      : []
    const [previous] = await tx
      .select({ id: runs.id, status: runs.status, driver: runs.driver })
      .from(runs)
      .where(and(eq(runs.userId, caller.user.id), eq(runs.clientRunId, clientRunId)))
      .limit(1)
    // The orchestrator service writes the state of the runs it drives; a VS Code snapshot would overwrite it.
    if (previous?.driver === 'orchestrator') throw conflict('This run is driven by the platform; VS Code does not report it.')
    const values = {
      workflowName: input.workflowName,
      status: input.status,
      startedAt: new Date(input.startedAt),
      finishedAt: toDate(input.finishedAt),
      error: input.error,
      pendingApproval: input.pendingApproval,
      tokensIn,
      tokensOut,
      changedFiles,
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.engineModel ? { engineModel: input.engineModel } : {}),
      ...(input.engineSessionId ? { engineSessionId: input.engineSessionId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId, workflowVersion: input.workflowVersion } : {}),
      ...(task ? { taskId: task.id } : {}),
      updatedAt: new Date(),
    }
    const [run] = await tx
      .insert(runs)
      .values({
        orgId: caller.user.orgId,
        projectId: access.project.id,
        storyId: story.id,
        userId: caller.user.id,
        origin: 'extension',
        clientRunId,
        ...values,
      })
      .onConflictDoUpdate({ target: [runs.userId, runs.clientRunId], set: values })
      .returning({ id: runs.id })

    const before = previous
      ? await tx.select({ stepId: runSteps.stepId, approval: runSteps.approval }).from(runSteps).where(eq(runSteps.runId, run.id))
      : []
    const decidedBefore = new Set(before.filter((s) => s.approval).map((s) => s.stepId))
    for (const s of input.steps) {
      const stepValues = {
        seq: s.seq,
        nodeId: s.nodeId,
        kind: s.kind,
        label: s.label,
        status: s.status,
        startedAt: toDate(s.startedAt),
        finishedAt: toDate(s.finishedAt),
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        gatePass: s.gatePass,
        gateReason: s.gateReason,
        approval: s.approval,
        output: s.output,
        plan: s.plan,
        error: s.error,
        changedFiles: s.changedFiles,
        evaluations: s.evaluations,
        reportUrl: s.reportUrl,
        agentSlug: s.agentSlug,
        agentName: s.agentName,
        skills: s.skills,
        skillsUsed: s.skillsUsed,
        model: s.model,
        toolCalls: s.toolCalls,
      }
      await tx
        .insert(runSteps)
        .values({ runId: run.id, stepId: s.stepId, ...stepValues })
        .onConflictDoUpdate({ target: [runSteps.runId, runSteps.stepId], set: stepValues })
      for (const e of s.evaluations) {
        const evalValues = {
          nodeId: s.nodeId,
          stepLabel: s.label,
          score: e.score,
          threshold: e.threshold,
          pass: e.pass,
          required: e.required ?? null,
          reason: e.reason ?? null,
          passedCount: e.counts?.passed ?? null,
          failedCount: e.counts?.failed ?? null,
          erroredCount: e.counts?.errored ?? null,
          tokensIn: e.tokensIn ?? null,
          tokensOut: e.tokensOut ?? null,
          source: e.source ?? null,
          evalId: e.evalId ?? null,
          evalRunId: e.evalRunId ?? null,
          reportUrl: s.reportUrl,
          details: e.details ?? null,
          updatedAt: new Date(),
        }
        await tx
          .insert(runEvaluations)
          .values({ runId: run.id, stepId: s.stepId, evaluator: e.evaluator, ...evalValues })
          .onConflictDoUpdate({ target: [runEvaluations.runId, runEvaluations.stepId, runEvaluations.evaluator], set: evalValues })
      }
    }

    const audit = (action: string, data: Record<string, unknown>) =>
      writeAudit(tx, {
        orgId: caller.user.orgId,
        projectId: access.project.id,
        actorUserId: caller.user.id,
        action,
        resourceType: 'run',
        resourceId: run.id,
        data: { key: `${access.project.key}-${number}`, workflow: input.workflowName, engine: input.engine ?? undefined, ...data },
        via: caller.via,
      })
    if (!previous) await audit('run.started', {})
    if (TERMINAL.has(input.status) && previous?.status !== input.status) {
      await audit(`run.${input.status}`, { files: changedFiles.length, error: input.error ?? undefined })
    }
    for (const s of input.steps) {
      if (s.approval && !decidedBefore.has(s.stepId)) {
        await audit('run.approval_decided', { step: s.label, approve: s.approval.approve, comment: s.approval.comment ?? null })
      }
    }

    const captured = await captureRunMemory(
      tx,
      { orgId: caller.user.orgId, projectId: access.project.id, storyId: story.id, userId: caller.user.id },
      { id: run.id, workflowName: input.workflowName, status: input.status, changedFiles },
      input.steps,
    )
    return { id: run.id, captured, ended: TERMINAL.has(input.status) && previous?.status !== input.status }
  })

  publishWork(deps, access, number, 'run', caller.user.id, result.id)
  // First report of the run's end: a completed run that changed code proposes a project profile update.
  if (result.ended) deps.profiles?.runEnded(result.id)
  if (result.captured > 0) {
    deps.bus.publish({ type: 'memory.changed', projectKey: access.project.key, storyNumber: number, action: 'captured', actorId: caller.user.id })
  }
  return { id: result.id }
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

export async function storyWork(db: Db, user: AuthUser, key: string, number: number): Promise<StoryWork> {
  const access = await loadProjectAccess(db, user, key)
  const story = await loadStory(db, access, number)

  const workspaces = await db
    .select({
      userId: storyWorkspaces.userId,
      branch: storyWorkspaces.branch,
      headSha: storyWorkspaces.headSha,
      ahead: storyWorkspaces.ahead,
      behind: storyWorkspaces.behind,
      files: storyWorkspaces.files,
      additions: storyWorkspaces.additions,
      deletions: storyWorkspaces.deletions,
      hasPatch: sql<boolean>`${storyWorkspaces.patch} is not null`,
      patchTruncated: storyWorkspaces.patchTruncated,
      updatedAt: storyWorkspaces.updatedAt,
    })
    .from(storyWorkspaces)
    .where(eq(storyWorkspaces.storyId, story.id))
    .orderBy(desc(storyWorkspaces.updatedAt))

  const commits = await db
    .select({
      sha: storyCommits.sha,
      branch: storyCommits.branch,
      message: storyCommits.message,
      authorName: storyCommits.authorName,
      authorEmail: storyCommits.authorEmail,
      reportedBy: storyCommits.reportedBy,
      committedAt: storyCommits.committedAt,
      files: storyCommits.files,
      additions: storyCommits.additions,
      deletions: storyCommits.deletions,
      hasPatch: sql<boolean>`${storyCommits.patch} is not null`,
      patchTruncated: storyCommits.patchTruncated,
    })
    .from(storyCommits)
    .where(eq(storyCommits.storyId, story.id))
    .orderBy(desc(storyCommits.committedAt))
    .limit(200)

  const runRows = await db.select().from(runs).where(eq(runs.storyId, story.id)).orderBy(desc(runs.startedAt)).limit(50)
  const runIds = runRows.map((r) => r.id)
  const stepRows = runIds.length ? await db.select().from(runSteps).where(inArray(runSteps.runId, runIds)).orderBy(runSteps.seq) : []
  const evals = await evaluationsByStep(db, runIds)
  const tasks = await taskRefs(db, runRows, access.project.key)

  const people = await usersById(db, [
    ...workspaces.map((w) => w.userId),
    ...commits.map((c) => c.reportedBy),
    ...runRows.flatMap((r) => [r.userId, r.requestedBy]),
  ])

  return {
    workspaces: workspaces.flatMap((w) => {
      const user = people.get(w.userId)
      return user ? [{ ...w, user, updatedAt: w.updatedAt.toISOString() }] : []
    }),
    commits: commits.map(({ reportedBy, committedAt, ...c }) => ({
      ...c,
      reportedBy: reportedBy ? (people.get(reportedBy) ?? null) : null,
      committedAt: committedAt.toISOString(),
    })),
    runs: runRows.map((r) => toStoryRun(r, stepRows.filter((st) => st.runId === r.id), people, tasks, evals)),
  }
}

type RunRow = typeof runs.$inferSelect
type RunStepRow = typeof runSteps.$inferSelect
type People = Map<string, User>
type TaskRefs = Map<string, RunTaskRef>
/** Evaluations keyed by `runId:stepId`. */
type EvalsByStep = Map<string, EvaluationResult[]>

/** The stored evaluator verdicts of these runs, keyed by run and step. */
export async function evaluationsByStep(db: Db, runIds: string[]): Promise<EvalsByStep> {
  const out: EvalsByStep = new Map()
  if (!runIds.length) return out
  const rows = await db.select().from(runEvaluations).where(inArray(runEvaluations.runId, runIds)).orderBy(runEvaluations.evaluator)
  for (const r of rows) {
    const k = `${r.runId}:${r.stepId}`
    const list = out.get(k) ?? []
    list.push({
      evaluator: r.evaluator,
      score: r.score,
      threshold: r.threshold,
      pass: r.pass,
      required: r.required,
      reason: r.reason,
      counts:
        r.passedCount !== null || r.failedCount !== null || r.erroredCount !== null
          ? { passed: r.passedCount ?? 0, failed: r.failedCount ?? 0, errored: r.erroredCount ?? 0 }
          : null,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      source: (r.source as EvaluationResult['source']) ?? null,
      evalId: r.evalId,
      evalRunId: r.evalRunId,
      details: r.details,
    })
    out.set(k, list)
  }
  return out
}

/** The tasks these runs worked on. */
export async function taskRefs(db: Db, rows: { taskId: string | null }[], projectKey: string): Promise<TaskRefs> {
  const ids = [...new Set(rows.flatMap((r) => (r.taskId ? [r.taskId] : [])))]
  if (!ids.length) return new Map()
  const found = await db
    .select({ id: storyTasks.id, number: storyTasks.number, title: storyTasks.title, storyNumber: stories.number })
    .from(storyTasks)
    .innerJoin(stories, eq(stories.id, storyTasks.storyId))
    .where(inArray(storyTasks.id, ids))
  return new Map(found.map((t) => [t.id, { number: t.number, key: taskKey(`${projectKey}-${t.storyNumber}`, t.number), title: t.title }]))
}

function toStoryRunStep(s: RunStepRow, evals?: EvalsByStep): StoryRunStep {
  return {
    stepId: s.stepId,
    seq: s.seq,
    nodeId: s.nodeId,
    kind: s.kind,
    label: s.label,
    status: s.status,
    startedAt: s.startedAt?.toISOString() ?? null,
    finishedAt: s.finishedAt?.toISOString() ?? null,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    gatePass: s.gatePass,
    gateReason: s.gateReason,
    approval: s.approval ?? null,
    output: s.output,
    plan: s.plan,
    error: s.error,
    changedFiles: s.changedFiles,
    evaluations: evals?.get(`${s.runId}:${s.stepId}`) ?? s.evaluations ?? [],
    reportUrl: s.reportUrl,
    agentSlug: s.agentSlug,
    agentName: s.agentName,
    skills: s.skills,
    skillsUsed: s.skillsUsed ?? [],
    model: s.model,
    toolCalls: s.toolCalls,
    engine: s.engine,
  }
}

export function toRunSummary(r: RunRow, people: People, tasks: TaskRefs = new Map()): Omit<StoryRun, 'steps'> {
  return {
    id: r.id,
    clientRunId: r.clientRunId,
    origin: r.origin,
    driver: r.driver,
    workflowName: r.workflowName,
    workflowId: r.workflowId,
    workflowVersion: r.workflowVersion,
    engine: r.engine,
    engineModel: r.engineModel,
    task: r.taskId ? (tasks.get(r.taskId) ?? null) : null,
    prompt: r.prompt ?? null,
    requestedBy: r.requestedBy ? (people.get(r.requestedBy) ?? null) : null,
    requestedAt: r.requestedAt?.toISOString() ?? null,
    claimedAt: r.claimedAt?.toISOString() ?? null,
    clientId: r.clientId,
    status: r.status,
    startedBy: r.userId ? (people.get(r.userId) ?? null) : null,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    error: r.error,
    pendingApproval: r.pendingApproval ?? null,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    changedFiles: r.changedFiles,
  }
}

function toStoryRun(r: RunRow, steps: RunStepRow[], people: People, tasks: TaskRefs, evals: EvalsByStep): StoryRun {
  return { ...toRunSummary(r, people, tasks), steps: steps.map((st) => toStoryRunStep(st, evals)) }
}

const distinct = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))]

/** What a run worked on. */
export function runKind(r: Pick<RunRow, 'storyId' | 'taskId'>): ProjectRun['kind'] {
  return !r.storyId ? 'quick' : r.taskId ? 'task' : 'story'
}

/** Every run in the project, newest first — the web's Workflow › Runs table and the extension's Runs section. */
export async function projectRuns(db: Db, user: AuthUser, key: string, query: z.output<typeof RunListQuerySchema>): Promise<ProjectRun[]> {
  const access = await loadProjectAccess(db, user, key)
  const filters = [eq(runs.projectId, access.project.id)]
  if (query.status) filters.push(eq(runs.status, query.status))
  if (query.workflow) filters.push(eq(runs.workflowName, query.workflow))
  if (query.engine) filters.push(eq(runs.engine, query.engine))
  if (query.story) filters.push(eq(stories.number, query.story))
  if (query.task) filters.push(eq(storyTasks.number, query.task))
  if (query.user) filters.push(eq(runs.userId, query.user))
  if (query.kind === 'quick') filters.push(isNull(runs.storyId))
  if (query.kind === 'task') filters.push(isNotNull(runs.taskId))
  if (query.kind === 'story') filters.push(and(isNotNull(runs.storyId), isNull(runs.taskId)) as SQL)
  if (query.file) {
    const like = `%${query.file.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    filters.push(sql`exists (select 1 from unnest(${runs.changedFiles}) as f(path) where f.path ilike ${like})`)
  }
  const rows = await db
    .select({ run: runs, story: { number: stories.number, title: stories.title } })
    .from(runs)
    .leftJoin(stories, eq(stories.id, runs.storyId))
    .leftJoin(storyTasks, eq(storyTasks.id, runs.taskId))
    .where(and(...filters))
    .orderBy(desc(runs.startedAt))
    .limit(query.limit)
  const ids = rows.map((r) => r.run.id)
  const tallies = rows.length
    ? await db
        .select({
          runId: runSteps.runId,
          steps: sql<number>`count(*)::int`,
          passed: sql<number>`count(*) filter (where ${runSteps.gatePass} = true)::int`,
          failed: sql<number>`count(*) filter (where ${runSteps.gatePass} = false)::int`,
          agents: sql<(string | null)[]>`array_agg(distinct ${runSteps.agentSlug})`,
          skills: sql<(string | null)[]>`array_agg(distinct su.slug)`,
        })
        .from(runSteps)
        .leftJoin(sql`lateral jsonb_to_recordset(${runSteps.skillsUsed}) as su(slug text)`, sql`true`)
        .where(inArray(runSteps.runId, ids))
        .groupBy(runSteps.runId)
    : []
  const byRun = new Map(tallies.map((t) => [t.runId, t]))
  const [people, tasks, extras, iterations] = await Promise.all([
    usersById(db, rows.flatMap((r) => [r.run.userId, r.run.requestedBy].filter((v): v is string => Boolean(v)))),
    taskRefs(db, rows.map((r) => r.run), access.project.key),
    runListExtras(db, ids),
    runIterations(db, rows.map((r) => r.run)),
  ])
  return rows.map(({ run, story }) => ({
    ...toRunSummary(run, people, tasks),
    story: story ? { key: access.project.key, number: story.number, title: story.title } : null,
    stepCount: byRun.get(run.id)?.steps ?? 0,
    gatesPassed: byRun.get(run.id)?.passed ?? 0,
    gatesFailed: byRun.get(run.id)?.failed ?? 0,
    agentsUsed: distinct(byRun.get(run.id)?.agents ?? []),
    skillsUsed: distinct(byRun.get(run.id)?.skills ?? []),
    ...listFields(run, extras.get(run.id), iterations.get(run.id)?.number ?? null),
  }))
}

function listFields(run: RunRow, extra: RunListExtras | undefined, iteration: number | null) {
  return {
    kind: runKind(run),
    iteration,
    branch: extra?.branch ?? null,
    filesChanged: extra?.filesChanged ?? run.changedFiles.length,
    additions: extra?.additions ?? 0,
    deletions: extra?.deletions ?? 0,
    memoryUsed: extra?.memoryUsed ?? 0,
    memoryWritten: extra?.memoryWritten ?? 0,
    feedback: extra?.feedback ?? { up: 0, down: 0 },
  }
}

/** One run in full: its step timeline and evaluations, changes, memory, context, iteration and feedback. */
export async function projectRun(db: Db, user: AuthUser, key: string, runId: string): Promise<ProjectRunDetail> {
  const access = await loadProjectAccess(db, user, key)
  const [row] = await db
    .select({ run: runs, story: { number: stories.number, title: stories.title } })
    .from(runs)
    .leftJoin(stories, eq(stories.id, runs.storyId))
    .where(and(eq(runs.id, runId), eq(runs.projectId, access.project.id)))
    .limit(1)
  if (!row) throw notFound('Run')
  const steps = await db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(runSteps.seq)
  const [people, tasks, evals, extras, records] = await Promise.all([
    usersById(db, [row.run.userId, row.run.requestedBy].filter((v): v is string => Boolean(v))),
    taskRefs(db, [row.run], access.project.key),
    evaluationsByStep(db, [runId]),
    runListExtras(db, [runId]),
    runDetailRecords(db, access, row.run, steps),
  ])
  return {
    ...toRunSummary(row.run, people, tasks),
    story: row.story ? { key: access.project.key, number: row.story.number, title: row.story.title } : null,
    stepCount: steps.length,
    gatesPassed: steps.filter((st) => st.gatePass === true).length,
    gatesFailed: steps.filter((st) => st.gatePass === false).length,
    agentsUsed: distinct(steps.map((st) => st.agentSlug)),
    skillsUsed: distinct(steps.flatMap((st) => (st.skillsUsed ?? []).map((u) => u.slug))),
    ...listFields(row.run, extras.get(runId), records.attempt?.number ?? null),
    steps: steps.map((st) => toStoryRunStep(st, evals)),
    ...records,
    insight: null,
  }
}

export async function commitDiff(db: Db, user: AuthUser, key: string, number: number, sha: string): Promise<Patch> {
  const access = await loadProjectAccess(db, user, key)
  const story = await loadStory(db, access, number)
  const [row] = await db
    .select({ patch: storyCommits.patch, patchTruncated: storyCommits.patchTruncated })
    .from(storyCommits)
    .where(and(eq(storyCommits.storyId, story.id), eq(storyCommits.sha, sha.toLowerCase())))
    .limit(1)
  if (!row) throw notFound('Commit')
  return row
}

export async function workspaceDiff(db: Db | Tx, user: AuthUser, key: string, number: number, userId: string): Promise<Patch> {
  const access = await loadProjectAccess(db, user, key)
  const story = await loadStory(db, access, number)
  const [row] = await db
    .select({ patch: storyWorkspaces.patch, patchTruncated: storyWorkspaces.patchTruncated })
    .from(storyWorkspaces)
    .where(and(eq(storyWorkspaces.storyId, story.id), eq(storyWorkspaces.userId, userId)))
    .limit(1)
  if (!row) throw notFound('Working state')
  return row
}
