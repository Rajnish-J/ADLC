// Tasks under a story — like GitHub issues or Azure Boards Tasks under a user story. Whoever may edit the story may
// add and edit its tasks (developers: on stories assigned to them). Each change is audited and announced as a
// `story.changed` event with a `task.*` action, so the story views refresh.

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { taskKey, type CreateTaskInputSchema, type StoryTask, type TaskRunSummary, type UpdateTaskInput } from '@sdlc/contracts'
import type { z } from 'zod'
import { assertCan, loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db, Tx } from '../db/client'
import { projectMembers, runs, storyTasks } from '../db/schema'
import { usersById, type StoryRow } from '../dto'
import { badRequest, conflict, notFound } from '../http'
import type { Caller, ServiceDeps } from './context'
import { loadStory } from './stories'

type CreateTask = z.output<typeof CreateTaskInputSchema>
type TaskRow = typeof storyTasks.$inferSelect

export async function loadTask(db: Db | Tx, story: StoryRow, taskNumber: number): Promise<TaskRow> {
  const [row] = await db
    .select()
    .from(storyTasks)
    .where(and(eq(storyTasks.storyId, story.id), eq(storyTasks.number, taskNumber)))
    .limit(1)
  if (!row) throw notFound(`Task T${taskNumber}`)
  return row
}

/** Tasks as the API returns them, with assignees and each task's latest run. */
export async function toTasks(db: Db | Tx, rows: TaskRow[], storyKey: string, storyNumber: number): Promise<StoryTask[]> {
  if (!rows.length) return []
  const people = await usersById(db, rows.flatMap((r) => [r.assigneeId, r.createdBy]))
  const latest = await db
    .selectDistinctOn([runs.taskId], {
      taskId: runs.taskId,
      id: runs.id,
      status: runs.status,
      engine: runs.engine,
      startedAt: runs.startedAt,
      workflowId: runs.workflowId,
      workflowName: runs.workflowName,
    })
    .from(runs)
    // A request nobody picked up never ran: it doesn't say which workflow the task was worked with.
    .where(and(inArray(runs.taskId, rows.map((r) => r.id)), ne(runs.status, 'expired')))
    .orderBy(runs.taskId, desc(runs.startedAt))
  const runByTask = new Map<string, TaskRunSummary>(
    latest.map((r) => [
      r.taskId as string,
      { id: r.id, status: r.status, engine: r.engine, startedAt: r.startedAt.toISOString(), workflowId: r.workflowId, workflowName: r.workflowName },
    ]),
  )
  return rows.map((r) => ({
    id: r.id,
    storyNumber,
    number: r.number,
    key: taskKey(storyKey, r.number),
    title: r.title,
    description: r.description,
    status: r.status,
    assignee: r.assigneeId ? (people.get(r.assigneeId) ?? null) : null,
    rank: r.rank,
    external: r.external ?? null,
    latestRun: runByTask.get(r.id) ?? null,
    createdBy: people.get(r.createdBy) ?? { id: r.createdBy, email: '', displayName: 'Unknown', orgRole: 'member' },
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

export async function listTasks(db: Db, user: AuthUser, key: string, number: number): Promise<StoryTask[]> {
  const access = await loadProjectAccess(db, user, key)
  const story = await loadStory(db, access, number)
  const rows = await db
    .select()
    .from(storyTasks)
    .where(eq(storyTasks.storyId, story.id))
    .orderBy(asc(storyTasks.rank), asc(storyTasks.number))
  return toTasks(db, rows, `${access.project.key}-${number}`, number)
}

async function assertMember(tx: Tx, access: ProjectAccess, userId: string | null | undefined): Promise<void> {
  if (!userId) return
  const [m] = await tx
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, access.project.id), eq(projectMembers.userId, userId)))
    .limit(1)
  if (!m) throw badRequest('The assignee must be a member of the project.')
}

function publish(deps: ServiceDeps, access: ProjectAccess, number: number, action: string, actorId: string): void {
  deps.bus.publish({ type: 'story.changed', projectKey: access.project.key, storyNumber: number, action, actorId })
}

export async function createTask(deps: ServiceDeps, caller: Caller, key: string, number: number, input: CreateTask): Promise<StoryTask> {
  const row = await deps.db.transaction(async (tx) => {
    const access = await loadProjectAccess(tx, caller.user, key)
    const story = await loadStory(tx, access, number)
    assertCan(access, 'story.edit', story)
    await assertMember(tx, access, input.assigneeId)
    // Lock the story row so two concurrent creates get consecutive numbers.
    await tx.execute(sql`select id from stories where id = ${story.id} for update`)
    const [{ next, rank }] = await tx
      .select({
        next: sql<number>`coalesce(max(${storyTasks.number}), 0)::int + 1`,
        rank: sql<number>`coalesce(max(${storyTasks.rank}), 0) + 1024`,
      })
      .from(storyTasks)
      .where(eq(storyTasks.storyId, story.id))
    const [created] = await tx
      .insert(storyTasks)
      .values({
        projectId: access.project.id,
        storyId: story.id,
        number: next,
        title: input.title,
        description: input.description,
        assigneeId: input.assigneeId ?? null,
        external: input.external ?? null,
        rank,
        createdBy: caller.user.id,
      })
      .returning()
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'task.created',
      resourceType: 'story',
      resourceId: story.id,
      data: { key: taskKey(`${access.project.key}-${number}`, next), title: input.title },
      via: caller.via,
    })
    return { created, access }
  })
  publish(deps, row.access, number, 'task.created', caller.user.id)
  const [task] = await toTasks(deps.db, [row.created], `${row.access.project.key}-${number}`, number)
  return task
}

export async function updateTask(
  deps: ServiceDeps,
  caller: Caller,
  key: string,
  number: number,
  taskNumber: number,
  input: UpdateTaskInput,
): Promise<StoryTask> {
  const row = await deps.db.transaction(async (tx) => {
    const access = await loadProjectAccess(tx, caller.user, key)
    const story = await loadStory(tx, access, number)
    assertCan(access, 'story.edit', story)
    const task = await loadTask(tx, story, taskNumber)
    if (input.assigneeId !== undefined) await assertMember(tx, access, input.assigneeId)
    const set: Partial<typeof storyTasks.$inferInsert> = { updatedAt: new Date(), version: task.version + 1 }
    if (input.title !== undefined) set.title = input.title
    if (input.description !== undefined) set.description = input.description
    if (input.status !== undefined) set.status = input.status
    if (input.assigneeId !== undefined) set.assigneeId = input.assigneeId
    if (input.external !== undefined) set.external = input.external
    if (input.rank !== undefined) set.rank = input.rank
    const [updated] = await tx
      .update(storyTasks)
      .set(set)
      .where(and(eq(storyTasks.id, task.id), eq(storyTasks.version, input.version)))
      .returning()
    if (!updated) throw conflict('Someone else changed this task. Reload and try again.')
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: input.status && input.status !== task.status ? 'task.status_changed' : 'task.updated',
      resourceType: 'story',
      resourceId: story.id,
      data: { key: taskKey(`${access.project.key}-${number}`, taskNumber), from: task.status, to: updated.status },
      via: caller.via,
    })
    return { updated, access }
  })
  publish(deps, row.access, number, 'task.updated', caller.user.id)
  const [task] = await toTasks(deps.db, [row.updated], `${row.access.project.key}-${number}`, number)
  return task
}

export async function deleteTask(deps: ServiceDeps, caller: Caller, key: string, number: number, taskNumber: number): Promise<{ ok: true }> {
  const access = await deps.db.transaction(async (tx) => {
    const access = await loadProjectAccess(tx, caller.user, key)
    const story = await loadStory(tx, access, number)
    assertCan(access, 'story.edit', story)
    const task = await loadTask(tx, story, taskNumber)
    await tx.delete(storyTasks).where(eq(storyTasks.id, task.id))
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'task.deleted',
      resourceType: 'story',
      resourceId: story.id,
      data: { key: taskKey(`${access.project.key}-${number}`, taskNumber), title: task.title },
      via: caller.via,
    })
    return access
  })
  publish(deps, access, number, 'task.deleted', caller.user.id)
  return { ok: true }
}
