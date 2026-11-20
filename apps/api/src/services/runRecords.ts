// The full record of each agent run, beyond its steps: what it changed (VS Code reports the diff against the commit
// the run started from), the memory it was given and wrote, the context it worked from, which attempt it was at its
// story or task, people's feedback, and stats across runs for the Runs dashboard.

import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import {
  storyKey,
  taskKey,
  type ChangedFile,
  type Patch,
  type ProjectRunDetail,
  type ReportRunChangesInputSchema,
  type RunChanges,
  type RunContext,
  type RunFeedback,
  type RunFeedbackInput,
  type RunIteration,
  type RunMemory,
  type RunMemoryHelpfulInput,
  type RunStats,
  type RunStatsQuerySchema,
  type RunStepContext,
  type User,
} from '@sdlc/contracts'
import type { SpecNode, WorkflowSpec } from '@sdlc/core'
import type { z } from 'zod'
import { loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import { memoryItems, runChangeContents, runChanges, runFeedback, runMemoryReads, runSteps, runs, stories, storyTasks } from '../db/schema'
import { usersById } from '../dto'
import { notFound } from '../http'
import type { Caller, ServiceDeps } from './context'
import { captureRunMemory } from './memoryCapture'
import { loadOwnedRun, loadProjectRun, type RunRow } from './runAccess'

type ReportRunChanges = z.output<typeof ReportRunChangesInputSchema>
type RunStatsQuery = z.output<typeof RunStatsQuerySchema>
type RunStepRow = typeof runSteps.$inferSelect

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired'])

async function storyNumberOf(db: Db, run: RunRow): Promise<number | null> {
  if (!run.storyId) return null
  const [s] = await db.select({ number: stories.number }).from(stories).where(eq(stories.id, run.storyId)).limit(1)
  return s?.number ?? null
}

function publishRun(deps: ServiceDeps, projectKey: string, storyNumber: number | null, runId: string, actorId: string | null): void {
  deps.bus.publish({ type: 'work.changed', projectKey, storyNumber, kind: 'run', actorId, runId })
}

// ─── What a run changed ──────────────────────────────────────────────────────────────────────────

/**
 * VS Code's latest view of what the run changed. Replaces the previous report, keeps `runs.changed_files` in step,
 * and — when the run has already ended — refreshes its captured summary with the final file list.
 */
export async function reportRunChanges(deps: ServiceDeps, caller: Caller, key: string, runId: string, input: ReportRunChanges): Promise<{ ok: true; files: number }> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const run = await loadOwnedRun(deps.db, access, caller.user, runId)
  const additions = input.files.reduce((n, f) => n + f.additions, 0)
  const deletions = input.files.reduce((n, f) => n + f.deletions, 0)
  const paths = [...new Set(input.files.map((f) => f.path))].slice(0, 2000)
  const values = {
    branch: input.branch,
    baseSha: input.baseSha,
    headSha: input.headSha,
    files: input.files,
    additions,
    deletions,
    patch: input.patch,
    patchTruncated: input.patchTruncated,
    commits: input.commits,
    updatedAt: new Date(),
  }
  const captured = await deps.db.transaction(async (tx) => {
    await tx
      .insert(runChanges)
      .values({ runId: run.id, projectId: access.project.id, ...values })
      .onConflictDoUpdate({ target: runChanges.runId, set: values })
    await tx.update(runs).set({ changedFiles: paths, updatedAt: new Date() }).where(eq(runs.id, run.id))
    // The changed files' full text, for the Code page's view of the run's branch (older extensions send none).
    if (input.contents) {
      await tx.delete(runChangeContents).where(eq(runChangeContents.runId, run.id))
      const rows = input.contents.map((c) => ({
        runId: run.id,
        path: c.path,
        oldPath: c.oldPath ?? null,
        original: c.original,
        modified: c.modified,
        truncated: c.truncated,
      }))
      for (let i = 0; i < rows.length; i += 200) await tx.insert(runChangeContents).values(rows.slice(i, i + 200)).onConflictDoNothing()
    }
    if (!TERMINAL.has(run.status)) return 0
    const steps = await tx.select().from(runSteps).where(eq(runSteps.runId, run.id))
    return captureRunMemory(
      tx,
      { orgId: run.orgId, projectId: run.projectId, storyId: run.storyId, userId: run.userId },
      { id: run.id, workflowName: run.workflowName, status: run.status, changedFiles: paths, prompt: run.prompt },
      steps.map((s) => ({ ...s, approval: s.approval ?? null })),
      input.files,
    )
  })
  const number = await storyNumberOf(deps.db, run)
  publishRun(deps, access.project.key, number, run.id, caller.user.id)
  if (captured > 0) deps.bus.publish({ type: 'memory.changed', projectKey: access.project.key, storyNumber: number, action: 'captured', actorId: caller.user.id })
  // The run's final changes (often after the orchestrator reported it finished): propose a profile update.
  if (TERMINAL.has(run.status)) deps.profiles?.runEnded(run.id)
  return { ok: true, files: input.files.length }
}

export async function runDiff(db: Db, user: AuthUser, key: string, runId: string): Promise<Patch> {
  const access = await loadProjectAccess(db, user, key)
  await loadProjectRun(db, access, runId)
  const [row] = await db
    .select({ patch: runChanges.patch, patchTruncated: runChanges.patchTruncated })
    .from(runChanges)
    .where(eq(runChanges.runId, runId))
    .limit(1)
  return { patch: row?.patch ?? null, patchTruncated: row?.patchTruncated ?? false }
}

// ─── The runs table ──────────────────────────────────────────────────────────────────────────────

export interface RunListExtras {
  branch: string | null
  filesChanged: number | null
  additions: number
  deletions: number
  memoryUsed: number
  memoryWritten: number
  feedback: { up: number; down: number }
}

/** Change size, memory counts and feedback for each run in a list (four grouped queries, whatever the list size). */
export async function runListExtras(db: Db, runIds: string[]): Promise<Map<string, RunListExtras>> {
  const out = new Map<string, RunListExtras>()
  if (!runIds.length) return out
  const [changes, reads, written, feedback] = await Promise.all([
    db
      .select({
        runId: runChanges.runId,
        branch: runChanges.branch,
        files: sql<number>`jsonb_array_length(${runChanges.files})::int`,
        additions: runChanges.additions,
        deletions: runChanges.deletions,
      })
      .from(runChanges)
      .where(inArray(runChanges.runId, runIds)),
    db
      .select({ runId: runMemoryReads.runId, n: sql<number>`count(*)::int` })
      .from(runMemoryReads)
      .where(inArray(runMemoryReads.runId, runIds))
      .groupBy(runMemoryReads.runId),
    db
      .select({ runId: memoryItems.runId, n: sql<number>`count(*)::int` })
      .from(memoryItems)
      .where(inArray(memoryItems.runId, runIds))
      .groupBy(memoryItems.runId),
    db
      .select({
        runId: runFeedback.runId,
        up: sql<number>`count(*) filter (where ${runFeedback.rating} > 0)::int`,
        down: sql<number>`count(*) filter (where ${runFeedback.rating} < 0)::int`,
      })
      .from(runFeedback)
      .where(inArray(runFeedback.runId, runIds))
      .groupBy(runFeedback.runId),
  ])
  const get = (id: string): RunListExtras => {
    let e = out.get(id)
    if (!e) {
      e = { branch: null, filesChanged: null, additions: 0, deletions: 0, memoryUsed: 0, memoryWritten: 0, feedback: { up: 0, down: 0 } }
      out.set(id, e)
    }
    return e
  }
  for (const c of changes) Object.assign(get(c.runId), { branch: c.branch, filesChanged: c.files, additions: c.additions, deletions: c.deletions })
  for (const r of reads) get(r.runId).memoryUsed = r.n
  for (const w of written) if (w.runId) get(w.runId).memoryWritten = w.n
  for (const f of feedback) get(f.runId).feedback = { up: f.up, down: f.down }
  return out
}

/** Which attempt each run is at its story or task (runs of the same story and task, oldest first). */
export async function runIterations(db: Db, rows: { id: string; storyId: string | null }[]): Promise<Map<string, RunIteration>> {
  const storyIds = [...new Set(rows.flatMap((r) => (r.storyId ? [r.storyId] : [])))]
  if (!storyIds.length) return new Map()
  const order = sql`partition by ${runs.storyId}, ${runs.taskId} order by ${runs.startedAt}, ${runs.createdAt}`
  const found = await db
    .select({
      id: runs.id,
      number: sql<number>`(row_number() over (${order}))::int`,
      total: sql<number>`(count(*) over (partition by ${runs.storyId}, ${runs.taskId}))::int`,
      previousId: sql<string | null>`lag(${runs.id}) over (${order})`,
      nextId: sql<string | null>`lead(${runs.id}) over (${order})`,
    })
    .from(runs)
    .where(inArray(runs.storyId, storyIds))
  return new Map(found.map((f) => [f.id, { number: f.number, total: f.total, previousId: f.previousId, nextId: f.nextId }]))
}

// ─── One run in full ─────────────────────────────────────────────────────────────────────────────

/** The agent steps a run planned: from the workflow it started with, or (older runs) from its reported steps. */
export function runStepContext(spec: WorkflowSpec | null, steps: Pick<RunStepRow, 'kind' | 'nodeId' | 'label' | 'agentSlug' | 'agentName' | 'skills' | 'engine'>[], runEngine: string | null): RunStepContext[] {
  const agentNodes = (spec?.nodes ?? []).filter((n: SpecNode) => n.kind === 'agent')
  if (agentNodes.length) {
    return agentNodes.map((n) => ({
      nodeId: n.id,
      label: n.label || n.id,
      agentSlug: typeof n.data.agentId === 'string' ? n.data.agentId : null,
      agentName: typeof n.data.agentName === 'string' ? n.data.agentName : null,
      skills: Array.isArray(n.data.skills) ? n.data.skills.filter((s): s is string => typeof s === 'string') : [],
      harness: (typeof n.data.harness === 'string' && n.data.harness) || runEngine,
    }))
  }
  return steps
    .filter((s) => s.kind === 'agent')
    .map((s) => ({ nodeId: s.nodeId, label: s.label, agentSlug: s.agentSlug, agentName: s.agentName, skills: s.skills, harness: s.engine ?? runEngine }))
}

function toChanges(row: typeof runChanges.$inferSelect | undefined): RunChanges | null {
  if (!row) return null
  return {
    branch: row.branch,
    baseSha: row.baseSha,
    headSha: row.headSha,
    files: row.files as ChangedFile[],
    additions: row.additions,
    deletions: row.deletions,
    hasPatch: row.patch !== null && row.patch !== '',
    patchTruncated: row.patchTruncated,
    commits: row.commits,
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function runMemory(db: Db, access: ProjectAccess, runId: string): Promise<RunMemory> {
  const ref = {
    id: memoryItems.id,
    scope: memoryItems.scope,
    kind: memoryItems.kind,
    status: memoryItems.status,
    title: memoryItems.title,
    content: memoryItems.content,
    pinned: memoryItems.pinned,
    storyNumber: stories.number,
    createdAt: memoryItems.createdAt,
  }
  const [used, written] = await Promise.all([
    db
      .select({ ...ref, via: runMemoryReads.via, stepId: runMemoryReads.stepId, helpful: runMemoryReads.helpful, at: runMemoryReads.createdAt })
      .from(runMemoryReads)
      .innerJoin(memoryItems, eq(memoryItems.id, runMemoryReads.memoryItemId))
      .leftJoin(stories, eq(stories.id, memoryItems.storyId))
      .where(eq(runMemoryReads.runId, runId))
      .orderBy(runMemoryReads.createdAt),
    db
      .select({ ...ref, source: memoryItems.source })
      .from(memoryItems)
      .leftJoin(stories, eq(stories.id, memoryItems.storyId))
      .where(and(eq(memoryItems.runId, runId), eq(memoryItems.projectId, access.project.id)))
      .orderBy(memoryItems.createdAt),
  ])
  const writtenIds = written.map((w) => w.id)
  const later = writtenIds.length
    ? await db
        .select({ itemId: runMemoryReads.memoryItemId, runId: runMemoryReads.runId })
        .from(runMemoryReads)
        .where(and(inArray(runMemoryReads.memoryItemId, writtenIds), ne(runMemoryReads.runId, runId)))
    : []
  const usesByItem = new Map<string, number>()
  for (const l of later) usesByItem.set(l.itemId, (usesByItem.get(l.itemId) ?? 0) + 1)
  const key = (n: number | null) => (n === null ? null : storyKey(access.project.key, n))
  return {
    used: used.map((u) => ({
      id: u.id,
      scope: u.scope,
      kind: u.kind,
      status: u.status,
      title: u.title,
      content: u.content,
      pinned: u.pinned,
      storyKey: key(u.storyNumber),
      storyNumber: u.storyNumber,
      createdAt: u.createdAt.toISOString(),
      via: u.via,
      stepId: u.stepId,
      helpful: u.helpful,
      at: u.at.toISOString(),
    })),
    written: written.map((w) => ({
      id: w.id,
      scope: w.scope,
      kind: w.kind,
      status: w.status,
      title: w.title,
      content: w.content,
      pinned: w.pinned,
      storyKey: key(w.storyNumber),
      storyNumber: w.storyNumber,
      createdAt: w.createdAt.toISOString(),
      source: w.source,
      usedByRuns: usesByItem.get(w.id) ?? 0,
    })),
    usedLater: new Set(later.map((l) => l.runId)).size,
  }
}

async function feedbackOf(db: Db, runId: string): Promise<RunFeedback[]> {
  const rows = await db.select().from(runFeedback).where(eq(runFeedback.runId, runId)).orderBy(desc(runFeedback.updatedAt))
  const people = await usersById(
    db,
    rows.map((r) => r.userId),
  )
  return rows.flatMap((r) => {
    const user = people.get(r.userId)
    return user ? [{ user, rating: r.rating > 0 ? (1 as const) : (-1 as const), comment: r.comment, updatedAt: r.updatedAt.toISOString() }] : []
  })
}

/** Changes, memory, context, iteration and feedback of one run (the insight is attached by the route). */
export async function runDetailRecords(
  db: Db,
  access: ProjectAccess,
  run: RunRow,
  steps: RunStepRow[],
): Promise<Pick<ProjectRunDetail, 'changes' | 'memory' | 'context' | 'attempt' | 'feedbackEntries'>> {
  const [[changes], memory, feedback, iterations, [story], [task]] = await Promise.all([
    db.select().from(runChanges).where(eq(runChanges.runId, run.id)).limit(1),
    runMemory(db, access, run.id),
    feedbackOf(db, run.id),
    runIterations(db, [run]),
    run.storyId
      ? db.select({ number: stories.number, title: stories.title, description: stories.description }).from(stories).where(eq(stories.id, run.storyId)).limit(1)
      : Promise.resolve([]),
    run.taskId
      ? db.select({ number: storyTasks.number, title: storyTasks.title, description: storyTasks.description }).from(storyTasks).where(eq(storyTasks.id, run.taskId)).limit(1)
      : Promise.resolve([]),
  ])
  const sKey = story ? storyKey(access.project.key, story.number) : null
  const context: RunContext = {
    prompt: run.prompt,
    story: story && sKey ? { key: sKey, number: story.number, title: story.title, description: story.description } : null,
    task: task && sKey ? { key: taskKey(sKey, task.number), number: task.number, title: task.title, description: task.description } : null,
    steps: runStepContext(run.specSnapshot ?? null, steps, run.engine),
  }
  return { changes: toChanges(changes), memory, context, attempt: iterations.get(run.id) ?? null, feedbackEntries: feedback }
}

// ─── People's feedback ───────────────────────────────────────────────────────────────────────────

/** Rate a run (thumbs up / down, with an optional comment); a null rating removes the caller's feedback. */
export async function setRunFeedback(deps: ServiceDeps, caller: Caller, key: string, runId: string, input: RunFeedbackInput): Promise<RunFeedback[]> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const run = await loadProjectRun(deps.db, access, runId)
  if (input.rating === null) {
    await deps.db.delete(runFeedback).where(and(eq(runFeedback.runId, run.id), eq(runFeedback.userId, caller.user.id)))
  } else {
    const values = { rating: input.rating, comment: input.comment?.trim() || null, updatedAt: new Date() }
    await deps.db
      .insert(runFeedback)
      .values({ runId: run.id, userId: caller.user.id, ...values })
      .onConflictDoUpdate({ target: [runFeedback.runId, runFeedback.userId], set: values })
  }
  publishRun(deps, access.project.key, await storyNumberOf(deps.db, run), run.id, caller.user.id)
  return feedbackOf(deps.db, run.id)
}

/** Mark a memory item the run was given as helpful or not for it (null clears the rating). */
export async function setMemoryHelpful(deps: ServiceDeps, caller: Caller, key: string, runId: string, itemId: string, input: RunMemoryHelpfulInput): Promise<{ ok: true }> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const run = await loadProjectRun(deps.db, access, runId)
  const updated = await deps.db
    .update(runMemoryReads)
    .set({ helpful: input.helpful })
    .where(and(eq(runMemoryReads.runId, run.id), eq(runMemoryReads.memoryItemId, itemId)))
    .returning({ id: runMemoryReads.memoryItemId })
  if (!updated.length) throw notFound('Memory item for this run')
  publishRun(deps, access.project.key, await storyNumberOf(deps.db, run), run.id, caller.user.id)
  return { ok: true }
}

// ─── Across runs ─────────────────────────────────────────────────────────────────────────────────

export interface StatsRun {
  id: string
  status: string
  engine: string | null
  userId: string | null
  startedAt: Date
  finishedAt: Date | null
  changedFiles: string[]
}

export interface StatsChanges {
  runId: string
  files: number
  additions: number
  deletions: number
}

const ACTIVE = new Set(['requested', 'queued', 'running', 'awaiting_approval'])

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/** Totals, runs per day / person / harness, and the files changed most often. Pure — unit-tested. */
export function summarizeRunStats(rows: StatsRun[], changes: StatsChanges[], people: Map<string, User>, days: number, now = new Date()): RunStats {
  const byRun = new Map(changes.map((c) => [c.runId, c]))
  const durations = (list: StatsRun[]) =>
    list.filter((r) => r.status === 'completed' && r.finishedAt).map((r) => (r.finishedAt as Date).getTime() - r.startedAt.getTime())
  const completed = rows.filter((r) => r.status === 'completed').length
  const failed = rows.filter((r) => r.status === 'failed').length

  const perDay = new Map<string, { date: string; completed: number; failed: number; cancelled: number; other: number }>()
  for (let i = days - 1; i >= 0; i--) {
    const date = dayOf(new Date(now.getTime() - i * 86_400_000))
    perDay.set(date, { date, completed: 0, failed: 0, cancelled: 0, other: 0 })
  }
  const perUser = new Map<string, { runs: number; completed: number; failed: number }>()
  const perHarness = new Map<string, { engine: string | null; list: StatsRun[] }>()
  const hot = new Map<string, number>()
  let filesChanged = 0
  let additions = 0
  let deletions = 0

  for (const r of rows) {
    const day = perDay.get(dayOf(r.startedAt))
    if (day) {
      if (r.status === 'completed') day.completed++
      else if (r.status === 'failed') day.failed++
      else if (r.status === 'cancelled' || r.status === 'expired') day.cancelled++
      else day.other++
    }
    if (r.userId) {
      const u = perUser.get(r.userId) ?? { runs: 0, completed: 0, failed: 0 }
      u.runs++
      if (r.status === 'completed') u.completed++
      if (r.status === 'failed') u.failed++
      perUser.set(r.userId, u)
    }
    const h = perHarness.get(r.engine ?? '') ?? { engine: r.engine, list: [] }
    h.list.push(r)
    perHarness.set(r.engine ?? '', h)
    const c = byRun.get(r.id)
    filesChanged += c?.files ?? r.changedFiles.length
    additions += c?.additions ?? 0
    deletions += c?.deletions ?? 0
    for (const path of new Set(r.changedFiles)) hot.set(path, (hot.get(path) ?? 0) + 1)
  }

  return {
    days,
    totals: {
      runs: rows.length,
      completed,
      failed,
      cancelled: rows.filter((r) => r.status === 'cancelled' || r.status === 'expired').length,
      active: rows.filter((r) => ACTIVE.has(r.status)).length,
      // Completed out of runs that ran to an end on their own: a cancelled run was someone's choice, not a failure.
      successRate: completed + failed ? completed / (completed + failed) : null,
      medianDurationMs: median(durations(rows)),
      filesChanged,
      additions,
      deletions,
    },
    perDay: [...perDay.values()],
    perUser: [...perUser.entries()]
      .flatMap(([id, u]) => {
        const user = people.get(id)
        return user ? [{ user, ...u }] : []
      })
      .sort((a, b) => b.runs - a.runs),
    perHarness: [...perHarness.values()]
      .map((h) => ({
        engine: h.engine,
        runs: h.list.length,
        completed: h.list.filter((r) => r.status === 'completed').length,
        failed: h.list.filter((r) => r.status === 'failed').length,
        medianDurationMs: median(durations(h.list)),
      }))
      .sort((a, b) => b.runs - a.runs),
    hotspots: [...hot.entries()]
      .map(([path, n]) => ({ path, runs: n }))
      .sort((a, b) => b.runs - a.runs || a.path.localeCompare(b.path))
      .slice(0, 10),
  }
}

export async function runStats(db: Db, user: AuthUser, key: string, query: RunStatsQuery): Promise<RunStats> {
  const access = await loadProjectAccess(db, user, key)
  const since = new Date(Date.now() - (query.days - 1) * 86_400_000)
  since.setUTCHours(0, 0, 0, 0)
  const filters = [eq(runs.projectId, access.project.id), gte(runs.startedAt, since)]
  if (query.user) filters.push(eq(runs.userId, query.user))
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      engine: runs.engine,
      userId: runs.userId,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      changedFiles: runs.changedFiles,
    })
    .from(runs)
    .where(and(...filters))
    .orderBy(desc(runs.startedAt))
    .limit(5_000)
  const ids = rows.map((r) => r.id)
  const changes = ids.length
    ? await db
        .select({ runId: runChanges.runId, files: sql<number>`jsonb_array_length(${runChanges.files})::int`, additions: runChanges.additions, deletions: runChanges.deletions })
        .from(runChanges)
        .where(inArray(runChanges.runId, ids))
    : []
  const people = await usersById(
    db,
    rows.map((r) => r.userId),
  )
  return summarizeRunStats(rows, changes, people, query.days)
}
