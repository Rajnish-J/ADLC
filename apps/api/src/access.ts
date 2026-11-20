// Project access: resolve a project by key and the caller's role in it, and assert permissions with the shared
// rules from @sdlc/contracts. A project the caller may not see answers 404, not 403, so keys don't leak.

import { and, eq, isNull } from 'drizzle-orm'
import {
  can,
  canUseAgent,
  type Actor,
  type AgentAccessRule,
  type Permission,
  type ProjectRole,
  type StoryOwnership,
} from '@sdlc/contracts'
import type { AuthUser } from './auth'
import type { Db, Tx } from './db/client'
import { projectMembers, projects } from './db/schema'
import { forbidden, notFound } from './http'

export type ProjectRow = typeof projects.$inferSelect

export interface ProjectAccess {
  project: ProjectRow
  /** The caller's project role; undefined for an org admin who isn't a member. */
  role: ProjectRole | undefined
  actor: Actor
}

export function actorOf(user: AuthUser): Actor {
  return { userId: user.id, orgRole: user.orgRole }
}

export async function loadProjectAccess(db: Db | Tx, user: AuthUser, key: string): Promise<ProjectAccess> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, user.orgId), eq(projects.key, key.toUpperCase()), isNull(projects.archivedAt)))
    .limit(1)
  if (!project) throw notFound('Project')

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)))
    .limit(1)
  const role = member?.role
  if (!role && user.orgRole !== 'org_admin') throw notFound('Project')

  return { project, role, actor: actorOf(user) }
}

export function assertCan(access: ProjectAccess, perm: Permission, story?: StoryOwnership): void {
  if (!can(access.actor, access.role, perm, story)) throw forbidden()
}

/** The agent's own role restriction (e.g. Wayfinder: lead and above). Checked on enable, map and run. */
export function assertCanUseAgent(access: ProjectAccess, agent: AgentAccessRule): void {
  if (!canUseAgent(access.actor, access.role, agent)) throw forbidden()
}
