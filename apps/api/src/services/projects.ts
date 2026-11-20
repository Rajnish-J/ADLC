// Projects and their members.

import { and, asc, count, eq, inArray, isNotNull, isNull, like } from 'drizzle-orm'
import {
  assignableRoles,
  can,
  permissionsFor,
  readProjectSettings,
  STORY_STATUSES,
  suggestProjectKey,
  type AddMemberInput,
  type CreateProjectInput,
  type ProjectDetail,
  type ProjectRole,
  type ProjectSummary,
  type StoryStatus,
  type UpdateMemberInput,
} from '@sdlc/contracts'
import { actorOf, assertCan, loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db, Tx } from '../db/client'
import { agents, projectAgents, projectMembers, projectRepositories, projects, stories, users, workflows } from '../db/schema'
import { toUser } from '../dto'
import { badRequest, conflict, forbidden, HttpError, isUniqueViolation, notFound } from '../http'
import { requireGit } from '../repo/runtime'
import { connectionById } from '../repo/connections'
import { newRepositoryValues } from '../repo/service'
import { createWorkspaceBranch, WORKSPACE_BRANCH, writeWorkspaceFiles } from '../repo/workspace'
import type { Caller, ServiceDeps } from './context'

function emptyCounts(): Record<StoryStatus, number> {
  return Object.fromEntries(STORY_STATUSES.map((s) => [s, 0])) as Record<StoryStatus, number>
}

async function storyCounts(db: Db | Tx, projectIds: string[]): Promise<Map<string, Record<StoryStatus, number>>> {
  const out = new Map(projectIds.map((id) => [id, emptyCounts()]))
  if (projectIds.length === 0) return out
  const rows = await db
    .select({ projectId: stories.projectId, status: stories.status, n: count() })
    .from(stories)
    .where(inArray(stories.projectId, projectIds))
    .groupBy(stories.projectId, stories.status)
  for (const r of rows) out.get(r.projectId)![r.status] = r.n
  return out
}

/** Projects the user can see: all of them for an org admin, otherwise the ones they're a member of. */
export async function listProjects(db: Db, user: AuthUser): Promise<ProjectSummary[]> {
  const isAdmin = user.orgRole === 'org_admin'
  const rows = await db
    .select({
      project: projects,
      role: projectMembers.role,
      repo: { provider: projectRepositories.provider, status: projectRepositories.status, displayName: projectRepositories.displayName },
    })
    .from(projects)
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
    .leftJoin(projectRepositories, eq(projectRepositories.projectId, projects.id))
    .where(
      and(
        eq(projects.orgId, user.orgId),
        isNull(projects.archivedAt),
        isAdmin ? undefined : isNotNull(projectMembers.userId),
      ),
    )
    .orderBy(asc(projects.name))
  const counts = await storyCounts(
    db,
    rows.map((r) => r.project.id),
  )
  return rows.map(({ project, role, repo }) => ({
    id: project.id,
    key: project.key,
    name: project.name,
    description: project.description,
    myRole: role ?? null,
    storyCounts: counts.get(project.id) ?? emptyCounts(),
    repository: repo?.provider && repo.status && repo.displayName ? { provider: repo.provider, status: repo.status, displayName: repo.displayName } : null,
    settings: readProjectSettings(project.settings),
  }))
}

export async function projectDetail(db: Db, user: AuthUser, key: string): Promise<ProjectDetail> {
  const access = await loadProjectAccess(db, user, key)
  const { project, role, actor } = access
  const memberRows = await db
    .select({ user: users, role: projectMembers.role, addedAt: projectMembers.addedAt })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, project.id))
    .orderBy(asc(users.displayName))
  const counts = await storyCounts(db, [project.id])
  const [linked] = await db
    .select({
      provider: projectRepositories.provider,
      status: projectRepositories.status,
      displayName: projectRepositories.displayName,
      remoteUrl: projectRepositories.remoteUrl,
    })
    .from(projectRepositories)
    .where(eq(projectRepositories.projectId, project.id))
    .limit(1)
  const linkedUrl = linked?.remoteUrl ?? null
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    description: project.description,
    // The linked repository's remote, else the URL the project was created with. A blank project's DB workspace
    // (workspace://…) has no remote — VS Code windows and clones match on this.
    repoUrl: project.repoUrl ?? (linkedUrl && !linkedUrl.startsWith('workspace://') ? linkedUrl : null),
    settings: readProjectSettings(project.settings),
    createdAt: project.createdAt.toISOString(),
    myRole: role ?? null,
    storyCounts: counts.get(project.id) ?? emptyCounts(),
    repository: linked ? { provider: linked.provider, status: linked.status, displayName: linked.displayName } : null,
    members: memberRows.map((m) => ({ user: toUser(m.user), role: m.role, addedAt: m.addedAt.toISOString() })),
    permissions: permissionsFor(actor, role),
    assignableRoles: assignableRoles(actor, role),
  }
}

/** A free project key for `name`: its suggestion, else the suggestion with 2, 3, … (still at most 10 characters). */
export async function uniqueProjectKey(db: ServiceDeps['db'], orgId: string, name: string): Promise<string> {
  const base = suggestProjectKey(name) || 'PRJ'
  const taken = new Set(
    (await db.select({ key: projects.key }).from(projects).where(and(eq(projects.orgId, orgId), like(projects.key, `${base.slice(0, 2)}%`)))).map((p) => p.key),
  )
  if (!taken.has(base)) return base
  for (let n = 2; n < 100_000; n++) {
    const suffix = String(n)
    const key = base.slice(0, 10 - suffix.length) + suffix
    if (!taken.has(key)) return key
  }
  throw conflict('Could not find a free project key — enter one yourself.')
}

/**
 * Create a project. The creator becomes its owner; every catalog agent is enabled for it; and it gets its own
 * copy of the platform workflow templates (SDLC Default is its default workflow). With a repository, the project
 * links it and its first clone is queued; with `workspace`, it starts with a blank workspace held by the platform
 * (a README on `main`), ready to edit at once. Without a key, one is generated from the name.
 */
export async function createProject(
  deps: ServiceDeps,
  caller: Caller,
  input: { key?: string; name: string; description: string; repository?: CreateProjectInput['repository']; workspace?: boolean },
): Promise<ProjectDetail> {
  const { user } = caller
  if (!can(actorOf(user), undefined, 'project.create')) throw forbidden('Only an org admin can create projects.')
  const { repos } = deps
  if (input.workspace && input.repository) throw badRequest('Pick a repository or a blank workspace, not both.')
  let repoValues: ReturnType<typeof newRepositoryValues> | null = null
  if (input.repository) {
    if (!repos) throw new HttpError(503, 'repositories_unavailable', 'Repositories can only be linked through the API server.')
    requireGit(repos.rt)
    // Validated before anything is written, so a bad URL never leaves a half-made project.
    repoValues = newRepositoryValues(repos.rt, '', user.id, input.repository)
    if (input.repository.connectionId) {
      const connection = await connectionById(deps.db, user.orgId, input.repository.connectionId)
      if (connection.provider !== repoValues.provider) throw badRequest(`That connection is for ${connection.provider === 'github' ? 'GitHub' : 'Azure DevOps'}, not this repository.`)
    }
  }
  if (input.workspace && !repos) throw new HttpError(503, 'repositories_unavailable', 'Workspaces can only be created through the API server.')
  const key = input.key ?? (await uniqueProjectKey(deps.db, user.orgId, input.name))

  const project = await deps.db.transaction(async (tx) => {
    let created
    try {
      ;[created] = await tx
        .insert(projects)
        .values({
          orgId: user.orgId,
          key,
          name: input.name,
          description: input.description,
          createdBy: user.id,
        })
        .returning()
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`Project key ${key} is already taken.`)
      throw err
    }
    await tx.insert(projectMembers).values({ projectId: created.id, userId: user.id, role: 'owner', addedBy: user.id })

    // Built-ins only: repo-discovered agents belong to the project whose codebase they came from.
    const catalog = await tx.select({ id: agents.id }).from(agents).where(isNull(agents.projectId))
    if (catalog.length > 0) {
      await tx.insert(projectAgents).values(catalog.map((a) => ({ projectId: created.id, agentId: a.id, enabled: true })))
    }
    const templates = await tx.select().from(workflows).where(isNull(workflows.projectId))
    if (templates.length > 0) {
      await tx.insert(workflows).values(
        templates.map((t) => ({
          projectId: created.id,
          name: t.name,
          description: t.description,
          isDefault: t.isDefault,
          spec: t.spec,
        })),
      )
    }

    await writeAudit(tx, {
      orgId: user.orgId,
      projectId: created.id,
      actorUserId: user.id,
      action: 'project.created',
      resourceType: 'project',
      resourceId: created.id,
      data: { key: created.key, name: created.name },
      via: caller.via,
    })

    let repositoryId: string | null = null
    if (repoValues) {
      const [repo] = await tx
        .insert(projectRepositories)
        .values({ ...repoValues, projectId: created.id })
        .returning()
      await tx.update(projects).set({ repoUrl: repo.remoteUrl }).where(eq(projects.id, created.id))
      await writeAudit(tx, {
        orgId: user.orgId,
        projectId: created.id,
        actorUserId: user.id,
        action: 'repo.linked',
        resourceType: 'repository',
        resourceId: repo.id,
        data: { repository: repo.displayName, provider: repo.provider },
        via: caller.via,
      })
      repositoryId = repo.id
    }

    if (input.workspace && repos) {
      const [repo] = await tx
        .insert(projectRepositories)
        .values({
          projectId: created.id,
          provider: 'workspace',
          remoteUrl: `workspace://${created.id}`,
          webUrl: null,
          displayName: created.name,
          defaultBranch: WORKSPACE_BRANCH,
          defaultBranchPinned: true,
          status: 'ready',
          lastSyncedAt: new Date(),
          createdBy: user.id,
        })
        .returning()
      const branch = await createWorkspaceBranch(tx, repo.id)
      await writeWorkspaceFiles(tx, repo, branch, [{ path: 'README.md', content: `# ${created.name}\n${created.description ? `\n${created.description}\n` : ''}` }], user.displayName, 'Start the workspace', repos.rt.maxFileBytes)
      await writeAudit(tx, {
        orgId: user.orgId,
        projectId: created.id,
        actorUserId: user.id,
        action: 'repo.linked',
        resourceType: 'repository',
        resourceId: repo.id,
        data: { repository: repo.displayName, provider: 'workspace' },
        via: caller.via,
      })
    }
    return { ...created, repositoryId }
  })

  if (project.repositoryId && repos) await repos.enqueue(project.repositoryId, 'link', { requestedBy: user.id, via: caller.via })
  deps.bus.publish({ type: 'project.changed', projectKey: project.key, action: 'created', actorId: user.id })
  return projectDetail(deps.db, user, project.key)
}

function assertCanGrant(access: ProjectAccess, ...roles: ProjectRole[]): void {
  assertCan(access, 'project.manage_members')
  const grantable = assignableRoles(access.actor, access.role)
  if (!roles.every((r) => grantable.includes(r))) {
    throw forbidden(`You can only manage members with these roles: ${grantable.join(', ') || 'none'}.`)
  }
}

async function ownerCount(tx: Tx, projectId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, 'owner')))
  return row?.n ?? 0
}

export async function addMember(deps: ServiceDeps, caller: Caller, key: string, input: AddMemberInput): Promise<ProjectDetail> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  assertCanGrant(access, input.role)
  const [target] = await deps.db
    .select()
    .from(users)
    .where(and(eq(users.id, input.userId), eq(users.orgId, caller.user.orgId)))
    .limit(1)
  if (!target) throw notFound('User')

  await deps.db.transaction(async (tx) => {
    try {
      await tx
        .insert(projectMembers)
        .values({ projectId: access.project.id, userId: target.id, role: input.role, addedBy: caller.user.id })
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`${target.displayName} is already a member of ${access.project.key}.`)
      throw err
    }
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'member.added',
      resourceType: 'user',
      resourceId: target.id,
      data: { email: target.email, role: input.role },
      via: caller.via,
    })
  })
  deps.bus.publish({ type: 'project.changed', projectKey: access.project.key, action: 'member.added', actorId: caller.user.id })
  return projectDetail(deps.db, caller.user, key)
}

export async function updateMember(
  deps: ServiceDeps,
  caller: Caller,
  key: string,
  userId: string,
  input: UpdateMemberInput,
): Promise<ProjectDetail> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, access.project.id), eq(projectMembers.userId, userId)))
      .limit(1)
    if (!current) throw notFound('Member')
    assertCanGrant(access, current.role, input.role)
    if (current.role === 'owner' && input.role !== 'owner' && (await ownerCount(tx, access.project.id)) <= 1) {
      throw conflict('A project needs at least one owner.')
    }
    await tx
      .update(projectMembers)
      .set({ role: input.role })
      .where(and(eq(projectMembers.projectId, access.project.id), eq(projectMembers.userId, userId)))
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'member.role_changed',
      resourceType: 'user',
      resourceId: userId,
      data: { from: current.role, to: input.role },
      via: caller.via,
    })
  })
  deps.bus.publish({ type: 'project.changed', projectKey: access.project.key, action: 'member.updated', actorId: caller.user.id })
  return projectDetail(deps.db, caller.user, key)
}

export async function removeMember(deps: ServiceDeps, caller: Caller, key: string, userId: string): Promise<ProjectDetail> {
  const access = await loadProjectAccess(deps.db, caller.user, key)
  await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, access.project.id), eq(projectMembers.userId, userId)))
      .limit(1)
    if (!current) throw notFound('Member')
    assertCanGrant(access, current.role)
    if (current.role === 'owner' && (await ownerCount(tx, access.project.id)) <= 1) {
      throw conflict('A project needs at least one owner.')
    }
    await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, access.project.id), eq(projectMembers.userId, userId)))
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'member.removed',
      resourceType: 'user',
      resourceId: userId,
      data: { role: current.role },
      via: caller.via,
    })
  })
  deps.bus.publish({ type: 'project.changed', projectKey: access.project.key, action: 'member.removed', actorId: caller.user.id })
  return projectDetail(deps.db, caller.user, key)
}
