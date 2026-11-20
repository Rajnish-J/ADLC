// Roles and permissions. One constant map shared by the API (which enforces it on every request), the web app
// and the extension (which only use it to hide what the user can't do). Role ASSIGNMENTS live in the database
// (users.org_role, project_members.role); the role → permission mapping is code, so all three agree exactly.

export const ORG_ROLES = ['org_admin', 'member'] as const
export type OrgRole = (typeof ORG_ROLES)[number]

export const PROJECT_ROLES = ['owner', 'lead', 'developer', 'viewer'] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]

export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
  owner: 'Owner',
  lead: 'Lead',
  developer: 'Developer',
  viewer: 'Viewer',
}

export const PERMISSIONS = [
  'project.view',
  'project.create',
  'project.update',
  'project.manage_members',
  'story.create',
  'story.edit',
  'story.assign',
  'story.pickup',
  'story.transition',
  'agent.configure',
  'workflow.edit',
  'audit.view',
  'memory.write',
  'memory.curate',
  'work.report',
  /** Edit files of the linked repository, commit them, create branches and run a sync. */
  'code.edit',
  /** Link, change or remove the project's repository and its access token. */
  'repo.manage',
  'org.manage',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const VIEWER: Permission[] = ['project.view']
const DEVELOPER: Permission[] = [...VIEWER, 'story.pickup', 'story.edit', 'story.transition', 'memory.write', 'work.report', 'code.edit']
const LEAD: Permission[] = [
  ...DEVELOPER,
  'story.create',
  'story.assign',
  'project.manage_members',
  'agent.configure',
  'workflow.edit',
  'audit.view',
  'memory.curate',
]
const OWNER: Permission[] = [...LEAD, 'project.update', 'repo.manage']

export const ROLE_PERMISSIONS: Record<ProjectRole, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  developer: new Set(DEVELOPER),
  lead: new Set(LEAD),
  owner: new Set(OWNER),
}

/**
 * Permissions a developer holds only on stories assigned to them: editing and moving the story, adding to its
 * memory, and reporting code activity (working state, commits, agent runs) against it.
 */
const OWN_ONLY_FOR_DEVELOPER: ReadonlySet<Permission> = new Set(['story.edit', 'story.transition', 'memory.write', 'work.report'])

/** Permissions only an org admin holds — never granted by a project role. */
const ORG_ONLY: ReadonlySet<Permission> = new Set(['project.create', 'org.manage'])

export interface Actor {
  userId: string
  orgRole: OrgRole
}

/** The story an action targets, when the permission is story-scoped. */
export interface StoryOwnership {
  assigneeId: string | null
}

/**
 * Whether `actor`, holding `projectRole` in the project (undefined when not a member), may do `perm`.
 * Org admins may do everything, in every project. Developers may edit/transition only stories assigned to them.
 */
export function can(actor: Actor, projectRole: ProjectRole | undefined, perm: Permission, story?: StoryOwnership): boolean {
  if (actor.orgRole === 'org_admin') return true
  if (ORG_ONLY.has(perm) || !projectRole) return false
  if (!ROLE_PERMISSIONS[projectRole].has(perm)) return false
  if (projectRole === 'developer' && OWN_ONLY_FOR_DEVELOPER.has(perm)) {
    return story !== undefined && story.assigneeId === actor.userId
  }
  return true
}

/** Every project-level permission the actor holds (story-scoped ones listed if held on any story they own). */
export function permissionsFor(actor: Actor, projectRole: ProjectRole | undefined): Permission[] {
  if (actor.orgRole === 'org_admin') return [...PERMISSIONS]
  if (!projectRole) return []
  return PERMISSIONS.filter((p) => !ORG_ONLY.has(p) && ROLE_PERMISSIONS[projectRole].has(p))
}

/** Project roles from least to most privileged — used for "this role or above" checks. */
export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, developer: 1, lead: 2, owner: 3 }

/** An agent's own access rule: the minimum project role needed to use it (null = anyone who can see the project). */
export interface AgentAccessRule {
  minProjectRole: ProjectRole | null
}

/**
 * Whether the actor may USE an agent (enable it, map it into a workflow, run it). Everyone who can see the
 * project can still SEE every agent — restricted ones are shown locked. Org admins may use every agent.
 */
export function canUseAgent(actor: Actor, projectRole: ProjectRole | undefined, agent: AgentAccessRule): boolean {
  if (actor.orgRole === 'org_admin') return true
  if (!projectRole) return false
  if (!agent.minProjectRole) return true
  return PROJECT_ROLE_RANK[projectRole] >= PROJECT_ROLE_RANK[agent.minProjectRole]
}

/**
 * Which roles the actor may grant. Owners (and org admins) grant any role; leads may add or change only
 * developers and viewers, so a lead can never promote someone to lead or owner.
 */
export function assignableRoles(actor: Actor, projectRole: ProjectRole | undefined): ProjectRole[] {
  if (actor.orgRole === 'org_admin' || projectRole === 'owner') return [...PROJECT_ROLES]
  if (projectRole === 'lead') return ['developer', 'viewer']
  return []
}

/**
 * The whole rule set as plain data, for services not written in TypeScript (the Python orchestrator loads it as
 * `services/orchestrator/app/rbac.json`, regenerated by `npm run emit:rbac -w @sdlc/contracts`).
 */
export function rbacRules(): {
  permissions: Permission[]
  rolePermissions: Record<ProjectRole, Permission[]>
  ownOnlyForDeveloper: Permission[]
  orgOnly: Permission[]
  projectRoleRank: Record<ProjectRole, number>
} {
  return {
    permissions: [...PERMISSIONS],
    rolePermissions: Object.fromEntries(PROJECT_ROLES.map((r) => [r, PERMISSIONS.filter((p) => ROLE_PERMISSIONS[r].has(p))])) as Record<
      ProjectRole,
      Permission[]
    >,
    ownOnlyForDeveloper: PERMISSIONS.filter((p) => OWN_ONLY_FOR_DEVELOPER.has(p)),
    orgOnly: PERMISSIONS.filter((p) => ORG_ONLY.has(p)),
    projectRoleRank: { ...PROJECT_ROLE_RANK },
  }
}
