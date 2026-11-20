// User stories: create, edit, move through the board, pick up and assign. Every state change is a conditional
// UPDATE guarded on the state the caller saw, so two people acting at once get a clean 409, never a lost write.

import { randomUUID } from 'crypto'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import {
  allowedTransitions,
  can,
  STORY_TRANSITIONS,
  STORY_STATUS_LABELS,
  type AssignInput,
  type CreateStoryInputSchema,
  type MoveStoryInput,
  type Story,
  type StoryStatus,
  type TransitionInput,
  type UpdateStoryInput,
} from '@sdlc/contracts'
import type { z } from 'zod'
import { assertCan, loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db, Tx } from '../db/client'
import { projectMembers, projects, stories } from '../db/schema'
import { toStories, type StoryRow } from '../dto'
import { badRequest, conflict, forbidden, notFound } from '../http'
import type { Caller, ServiceDeps } from './context'
import { captureStoryDone } from './memoryCapture'
import { bottomRank, hasPlacement, lockRanks, placeRank, type Placement } from './storyRank'

type CreateStory = z.output<typeof CreateStoryInputSchema>

export async function loadStory(db: Db | Tx, access: ProjectAccess, number: number): Promise<StoryRow> {
  const [row] = await db
    .select()
    .from(stories)
    .where(and(eq(stories.projectId, access.project.id), eq(stories.number, number)))
    .limit(1)
  if (!row) throw notFound(`Story ${access.project.key}-${number}`)
  return row
}

async function present(db: Db | Tx, access: ProjectAccess, row: StoryRow): Promise<Story> {
  const [story] = await toStories(db, [row], access.project.key, access.actor, access.role)
  return story
}

export async function listStories(db: Db, user: AuthUser, key: string): Promise<Story[]> {
  const access = await loadProjectAccess(db, user, key)
  const rows = await db
    .select()
    .from(stories)
    .where(eq(stories.projectId, access.project.id))
    .orderBy(asc(stories.rank), asc(stories.number))
  return toStories(db, rows, access.project.key, access.actor, access.role)
}

export async function getStory(db: Db, user: AuthUser, key: string, number: number): Promise<Story> {
  const access = await loadProjectAccess(db, user, key)
  return present(db, access, await loadStory(db, access, number))
}

/** Stories assigned to the user across every project they can see — the extension's "My stories". */
export async function myStories(db: Db, user: AuthUser): Promise<Story[]> {
  const rows = await db
    .select({ story: stories, projectKey: projects.key, role: projectMembers.role })
    .from(stories)
    .innerJoin(projects, eq(projects.id, stories.projectId))
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
    .where(and(eq(stories.assigneeId, user.id), isNull(projects.archivedAt), eq(projects.orgId, user.orgId)))
    .orderBy(asc(projects.key), asc(stories.rank), asc(stories.number))
  const out: Story[] = []
  for (const r of rows) {
    const [s] = await toStories(db, [r.story], r.projectKey, { userId: user.id, orgRole: user.orgRole }, r.role ?? undefined)
    out.push(s)
  }
  return out
}

function publishStory(deps: ServiceDeps, access: ProjectAccess, number: number, action: string, actorId: string): void {
  deps.bus.publish({ type: 'story.changed', projectKey: access.project.key, storyNumber: number, action, actorId })
}

export async function createStory(deps: ServiceDeps, caller: Caller, key: string, input: CreateStory): Promise<Story> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  assertCan(access, 'story.create')

  const row = await deps.db.transaction(async (tx) => {
    const [{ number }] = await tx
      .update(projects)
      .set({ nextStoryNumber: sql`${projects.nextStoryNumber} + 1` })
      .where(eq(projects.id, access.project.id))
      .returning({ number: sql<number>`${projects.nextStoryNumber} - 1` })
    await lockRanks(tx, access.project.id)
    const rank = await bottomRank(tx, access.project.id)
    const [created] = await tx
      .insert(stories)
      .values({
        projectId: access.project.id,
        number,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria.map((text) => ({ id: randomUUID(), text, met: false })),
        priority: input.priority,
        status: input.status,
        labels: input.labels,
        dueDate: input.dueDate ?? null,
        rank,
        createdBy: caller.user.id,
      })
      .returning()
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'story.created',
      resourceType: 'story',
      resourceId: created.id,
      data: { key: `${access.project.key}-${number}`, title: input.title, status: input.status },
      via: caller.via,
    })
    return created
  })

  publishStory(deps, access, row.number, 'created', caller.user.id)
  return present(deps.db, access, row)
}

export async function updateStory(
  deps: ServiceDeps,
  caller: Caller,
  key: string,
  number: number,
  input: UpdateStoryInput,
): Promise<Story> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const current = await loadStory(deps.db, access, number)
  assertCan(access, 'story.edit', current)

  // An assignee who isn't a lead works on the story but doesn't redefine it: they may update the description and
  // labels, tick criteria as met and flag a blocker — not change the title, priority, due date or the criteria.
  const isLead = can(access.actor, access.role, 'story.assign')
  if (!isLead) {
    if (input.title !== undefined || input.priority !== undefined || input.dueDate !== undefined) {
      throw forbidden('Only a lead or owner can change the title, priority or due date.')
    }
    if (input.acceptanceCriteria) {
      const before = current.acceptanceCriteria.map((c) => `${c.id}\u0000${c.text}`).join('\u0001')
      const after = input.acceptanceCriteria.map((c) => `${c.id}\u0000${c.text}`).join('\u0001')
      if (before !== after) throw forbidden('Only a lead or owner can change acceptance criteria; you can mark them met.')
    }
  }

  const changes: Partial<typeof stories.$inferInsert> = {}
  if (input.title !== undefined) changes.title = input.title
  if (input.description !== undefined) changes.description = input.description
  if (input.acceptanceCriteria !== undefined) changes.acceptanceCriteria = input.acceptanceCriteria
  if (input.priority !== undefined) changes.priority = input.priority
  if (input.isBlocked !== undefined) {
    changes.isBlocked = input.isBlocked
    changes.blockedReason = input.isBlocked ? (input.blockedReason ?? null) : null
  } else if (input.blockedReason !== undefined) {
    changes.blockedReason = input.blockedReason
  }
  if (input.labels !== undefined) changes.labels = input.labels
  if (input.dueDate !== undefined) changes.dueDate = input.dueDate
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to update.')

  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(stories)
      .set({ ...changes, version: sql`${stories.version} + 1`, updatedAt: new Date() })
      .where(and(eq(stories.id, current.id), eq(stories.version, input.version)))
      .returning()
    if (!updated) throw conflict('This story changed since you loaded it. Reload and try again.')
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'story.updated',
      resourceType: 'story',
      resourceId: current.id,
      data: { key: `${access.project.key}-${number}`, fields: Object.keys(changes), changes: describeChanges(current, input) },
      via: caller.via,
    })
    return updated
  })

  publishStory(deps, access, number, 'updated', caller.user.id)
  return present(deps.db, access, row)
}

export async function transitionStory(
  deps: ServiceDeps,
  caller: Caller,
  key: string,
  number: number,
  input: TransitionInput,
  place?: Placement,
): Promise<Story> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const current = await loadStory(deps.db, access, number)
  const exists = STORY_TRANSITIONS.some((t) => t.from === current.status && t.to === input.to)
  if (!exists) {
    throw conflict(`A story can't move from ${STORY_STATUS_LABELS[current.status]} to ${STORY_STATUS_LABELS[input.to]}.`)
  }
  if (!allowedTransitions(access.actor, access.role, current).some((t) => t.to === input.to)) throw forbidden()

  // Releasing a story back to Ready frees it for someone else to pick up.
  const releases = current.status === 'in_progress' && input.to === 'ready'
  let rolledUp = false
  const row = await deps.db.transaction(async (tx) => {
    const rank = await rankForDrop(tx, access, input.to, current.id, place)
    const [updated] = await tx
      .update(stories)
      .set({
        status: input.to,
        ...(releases ? { assigneeId: null } : {}),
        ...(rank !== null ? { rank } : {}),
        version: sql`${stories.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(stories.id, current.id), eq(stories.status, current.status)))
      .returning()
    if (!updated) throw conflict('This story changed since you loaded it. Reload and try again.')
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'story.transitioned',
      resourceType: 'story',
      resourceId: current.id,
      data: { key: `${access.project.key}-${number}`, from: current.status, to: input.to },
      via: caller.via,
    })
    // Done: propose what this story taught us for project memory (a lead accepts it).
    if (input.to === 'done') {
      rolledUp = await captureStoryDone(
        tx,
        { orgId: caller.user.orgId, projectId: access.project.id, storyId: current.id, userId: caller.user.id },
        { key: `${access.project.key}-${number}`, title: updated.title, acceptanceCriteria: updated.acceptanceCriteria },
      )
    }
    return updated
  })

  publishStory(deps, access, number, `moved to ${input.to}`, caller.user.id)
  if (rolledUp) deps.bus.publish({ type: 'memory.changed', projectKey: access.project.key, storyNumber: number, action: 'proposed', actorId: caller.user.id })
  return present(deps.db, access, row)
}

/** The caller assigns a Ready, unassigned story to themselves and starts it. First one wins; the rest get 409. */
export async function pickUpStory(
  deps: ServiceDeps,
  caller: Caller,
  key: string,
  number: number,
  place?: Placement,
): Promise<Story> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const current = await loadStory(deps.db, access, number)
  assertCan(access, 'story.pickup')

  const row = await deps.db.transaction(async (tx) => {
    const rank = await rankForDrop(tx, access, 'in_progress', current.id, place)
    const [updated] = await tx
      .update(stories)
      .set({
        assigneeId: caller.user.id,
        status: 'in_progress',
        ...(rank !== null ? { rank } : {}),
        version: sql`${stories.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(stories.id, current.id), eq(stories.status, 'ready'), isNull(stories.assigneeId)))
      .returning()
    if (!updated) throw conflict('This story is no longer ready to pick up — someone may have taken it first.')
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'story.picked_up',
      resourceType: 'story',
      resourceId: current.id,
      data: { key: `${access.project.key}-${number}` },
      via: caller.via,
    })
    return updated
  })

  publishStory(deps, access, number, 'picked up', caller.user.id)
  return present(deps.db, access, row)
}

/** A lead assigns (or unassigns) a story. Assigning a Ready story starts it; unassigning an in-progress one releases it. */
export async function assignStory(
  deps: ServiceDeps,
  caller: Caller,
  key: string,
  number: number,
  input: AssignInput,
): Promise<Story> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  assertCan(access, 'story.assign')
  const current = await loadStory(deps.db, access, number)

  if (input.userId) {
    const [member] = await deps.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, access.project.id), eq(projectMembers.userId, input.userId)))
      .limit(1)
    if (!member || member.role === 'viewer') {
      throw badRequest('The assignee must be a project member who works on stories (developer, lead or owner).')
    }
  }

  let status: StoryStatus = current.status
  if (input.userId && current.status === 'ready') status = 'in_progress'
  if (!input.userId && current.status === 'in_progress') status = 'ready'

  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(stories)
      .set({ assigneeId: input.userId, status, version: sql`${stories.version} + 1`, updatedAt: new Date() })
      .where(and(eq(stories.id, current.id), eq(stories.version, current.version)))
      .returning()
    if (!updated) throw conflict('This story changed since you loaded it. Reload and try again.')
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: input.userId ? 'story.assigned' : 'story.unassigned',
      resourceType: 'story',
      resourceId: current.id,
      data: { key: `${access.project.key}-${number}`, assigneeId: input.userId, status },
      via: caller.via,
    })
    return updated
  })

  publishStory(deps, access, number, input.userId ? 'assigned' : 'unassigned', caller.user.id)
  return present(deps.db, access, row)
}

// ─── Board drops ─────────────────────────────────────────────────────────────────────────────────

/** With a drop position, take the project's rank lock and work out where the story lands; otherwise keep its rank. */
async function rankForDrop(
  tx: Tx,
  access: ProjectAccess,
  status: StoryStatus,
  storyId: string,
  place: Placement | undefined,
): Promise<number | null> {
  if (!hasPlacement(place)) return null
  await lockRanks(tx, access.project.id)
  return placeRank(tx, access.project.id, status, storyId, place)
}

/** Reorder a story within its column. Needs edit rights on the story; the version stays as it is. */
async function reorderStory(deps: ServiceDeps, caller: Caller, access: ProjectAccess, current: StoryRow, place: Placement): Promise<Story> {
  assertCan(access, 'story.edit', current)
  const row = await deps.db.transaction(async (tx) => {
    await lockRanks(tx, access.project.id)
    const rank = await placeRank(tx, access.project.id, current.status, current.id, place)
    if (rank === null) throw conflict('The board changed since you loaded it. Reload and try again.')
    const [updated] = await tx
      .update(stories)
      .set({ rank })
      .where(and(eq(stories.id, current.id), eq(stories.status, current.status)))
      .returning()
    if (!updated) throw conflict('This story moved since you loaded it. Reload and try again.')
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'story.reordered',
      resourceType: 'story',
      resourceId: current.id,
      data: { key: `${access.project.key}-${current.number}`, status: current.status },
      via: caller.via,
    })
    return updated
  })
  publishStory(deps, access, current.number, 'reordered', caller.user.id)
  return present(deps.db, access, row)
}

/**
 * A drop on the board: the story goes to column `to`, between the cards it was dropped between. Another column
 * is a transition (or a pick-up, for Ready → In progress) under the same rules as the buttons; the same column
 * is a reorder.
 */
export async function moveStory(deps: ServiceDeps, caller: Caller, key: string, number: number, input: MoveStoryInput): Promise<Story> {
  const place: Placement = { afterId: input.afterId, beforeId: input.beforeId }
  const access = await loadProjectAccess(deps.db, caller.user, key)
  const current = await loadStory(deps.db, access, number)
  if (input.to === current.status) {
    if (!hasPlacement(place)) throw badRequest('Say where in the column the story goes (afterId or beforeId).')
    return reorderStory(deps, caller, access, current, place)
  }
  if (current.status === 'ready' && input.to === 'in_progress') return pickUpStory(deps, caller, key, number, place)
  return transitionStory(deps, caller, key, number, { to: input.to }, place)
}

/** What an edit changed, for the story's activity: "priority Medium → High", labels added and removed, … */
function describeChanges(current: StoryRow, input: UpdateStoryInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (input.title !== undefined && input.title !== current.title) out.title = { from: current.title, to: input.title }
  if (input.priority !== undefined && input.priority !== current.priority) out.priority = { from: current.priority, to: input.priority }
  if (input.dueDate !== undefined && input.dueDate !== current.dueDate) out.dueDate = { from: current.dueDate, to: input.dueDate }
  if (input.labels !== undefined) {
    const next = input.labels
    const added = next.filter((l) => !current.labels.includes(l))
    const removed = current.labels.filter((l) => !next.includes(l))
    if (added.length > 0 || removed.length > 0) out.labels = { added, removed }
  }
  if (input.isBlocked !== undefined && input.isBlocked !== current.isBlocked) {
    out.blocked = { to: input.isBlocked, reason: input.isBlocked ? (input.blockedReason ?? null) : null }
  }
  if (input.acceptanceCriteria !== undefined) {
    const before = new Map(current.acceptanceCriteria.map((c) => [c.id, c.met]))
    const met = input.acceptanceCriteria.filter((c) => c.met && before.get(c.id) === false).map((c) => c.text)
    const unmet = input.acceptanceCriteria.filter((c) => !c.met && before.get(c.id) === true).map((c) => c.text)
    if (met.length > 0 || unmet.length > 0) out.criteria = { met, unmet }
  }
  return out
}
