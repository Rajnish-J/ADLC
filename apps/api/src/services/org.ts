// Organisation administration (org admins only): people and their org role, and archiving / restoring projects.

import { and, asc, count, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { can, type ArchivedProject, type OrgPeople, type OrgRole } from '@sdlc/contracts'
import { actorOf, assertCan, loadProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db } from '../db/client'
import { organizations, projectMembers, projects, users } from '../db/schema'
import { toUser } from '../dto'
import { conflict, forbidden, notFound } from '../http'
import type { Caller, ServiceDeps } from './context'

function assertOrgAdmin(user: AuthUser): void {
  if (!can(actorOf(user), undefined, 'org.manage')) throw forbidden('Only an org admin can do that.')
}

export async function listPeople(db: Db, user: AuthUser): Promise<OrgPeople> {
  assertOrgAdmin(user)
  const [org] = await db.select().from(organizations).where(eq(organizations.id, user.orgId)).limit(1)
  const people = await db.select().from(users).where(eq(users.orgId, user.orgId)).orderBy(asc(users.displayName))
  const memberships = await db
    .select({ userId: projectMembers.userId, role: projectMembers.role, key: projects.key, name: projects.name })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projects.orgId, user.orgId), isNull(projects.archivedAt)))
    .orderBy(asc(projects.key))
  return {
    organization: { name: org?.name ?? 'Organization', slug: org?.slug ?? '' },
    people: people.map((p) => ({
      user: toUser(p),
      lastSeenAt: p.lastSeenAt?.toISOString() ?? null,
      projects: memberships.filter((m) => m.userId === p.id).map((m) => ({ key: m.key, name: m.name, role: m.role })),
    })),
  }
}

/** Make someone an org admin, or a member again. The organisation always keeps at least one org admin. */
export async function setOrgRole(deps: ServiceDeps, caller: Caller, userId: string, orgRole: OrgRole): Promise<OrgPeople> {
  const { user } = caller
  assertOrgAdmin(user)
  await deps.db.transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.orgId, user.orgId))).limit(1)
    if (!target) throw notFound('Person')
    if (target.orgRole === orgRole) return
    if (target.orgRole === 'org_admin') {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.orgId, user.orgId), eq(users.orgRole, 'org_admin')))
      if (n <= 1) throw conflict('The organization needs at least one org admin. Make someone else an org admin first.')
    }
    await tx.update(users).set({ orgRole }).where(eq(users.id, userId))
    await writeAudit(tx, {
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'org.role_changed',
      resourceType: 'user',
      resourceId: userId,
      data: { email: target.email, from: target.orgRole, to: orgRole },
      via: caller.via,
    })
  })
  return listPeople(deps.db, user)
}

/** Archive a project (owners and org admins): it disappears for everyone until an org admin restores it. */
export async function archiveProject(deps: ServiceDeps, caller: Caller, key: string): Promise<void> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  assertCan(access, 'project.update')
  await deps.db.transaction(async (tx) => {
    await tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, access.project.id))
    await writeAudit(tx, {
      orgId: access.project.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'project.archived',
      resourceType: 'project',
      resourceId: access.project.id,
      data: { key: access.project.key, name: access.project.name },
      via: caller.via,
    })
  })
  deps.bus.publish({ type: 'project.changed', projectKey: access.project.key, action: 'archived', actorId: caller.user.id })
}

export async function listArchived(db: Db, user: AuthUser): Promise<ArchivedProject[]> {
  assertOrgAdmin(user)
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, user.orgId), isNotNull(projects.archivedAt)))
    .orderBy(desc(projects.archivedAt))
  return rows.map((p) => ({ id: p.id, key: p.key, name: p.name, archivedAt: (p.archivedAt as Date).toISOString() }))
}

export async function restoreProject(deps: ServiceDeps, caller: Caller, id: string): Promise<ArchivedProject[]> {
  const { user } = caller
  assertOrgAdmin(user)
  const restored = await deps.db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.orgId, user.orgId), isNotNull(projects.archivedAt)))
      .limit(1)
    if (!p) throw notFound('Archived project')
    await tx.update(projects).set({ archivedAt: null }).where(eq(projects.id, id))
    await writeAudit(tx, {
      orgId: user.orgId,
      projectId: p.id,
      actorUserId: user.id,
      action: 'project.restored',
      resourceType: 'project',
      resourceId: p.id,
      data: { key: p.key, name: p.name },
      via: caller.via,
    })
    return p
  })
  deps.bus.publish({ type: 'project.changed', projectKey: restored.key, action: 'restored', actorId: user.id })
  return listArchived(deps.db, user)
}
