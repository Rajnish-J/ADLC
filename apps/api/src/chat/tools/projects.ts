// Projects, members and people.

import { and, asc, eq, ilike, or } from 'drizzle-orm'
import { z } from 'zod'
import { PROJECT_ROLES } from '@sdlc/contracts'
import { users } from '../../db/schema'
import { archiveProject } from '../../services/org'
import * as projectService from '../../services/projects'
import { updateProject } from '../../services/settings'
import { defineChatTool, person, projectOf, PROJECT_FIELD_DESCRIPTION } from './kit'

const project = z.string().nullable().describe(PROJECT_FIELD_DESCRIPTION)

export const projectTools = [
  defineChatTool({
    name: 'list_projects',
    label: 'List projects',
    access: 'read',
    description: 'List the projects the user can see, with their role, story counts by status and linked repository.',
    input: z.object({}),
    execute: async (ctx) => {
      const rows = await projectService.listProjects(ctx.deps.db, ctx.caller.user)
      return rows.map((p) => ({
        key: p.key,
        name: p.name,
        description: p.description,
        myRole: p.myRole,
        stories: p.storyCounts,
        repository: p.repository?.displayName ?? null,
      }))
    },
  }),
  defineChatTool({
    name: 'get_project',
    label: 'Read project',
    access: 'read',
    description: 'One project: description, members and their roles, engine settings, repository and what the user may do in it.',
    input: z.object({ project }),
    execute: async (ctx, { project: key }) => {
      const p = await projectService.projectDetail(ctx.deps.db, ctx.caller.user, projectOf(ctx, key))
      return {
        key: p.key,
        name: p.name,
        description: p.description,
        myRole: p.myRole,
        repoUrl: p.repoUrl,
        settings: p.settings,
        members: p.members.map((m) => ({ ...person(m.user), role: m.role })),
        myPermissions: p.permissions,
        rolesIGrant: p.assignableRoles,
      }
    },
  }),
  defineChatTool({
    name: 'find_people',
    label: 'Find people',
    access: 'read',
    description: 'Search people in the organization by name or email — to get the user id needed to add or assign someone.',
    input: z.object({ query: z.string().describe('Part of a name or email. Empty string lists everyone (first 50).') }),
    execute: async (ctx, { query }) => {
      const q = query.trim()
      const rows = await ctx.deps.db
        .select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(users)
        .where(and(eq(users.orgId, ctx.caller.user.orgId), q ? or(ilike(users.displayName, `%${q}%`), ilike(users.email, `%${q}%`)) : undefined))
        .orderBy(asc(users.displayName))
        .limit(50)
      return rows.map(person)
    },
  }),
  defineChatTool({
    name: 'update_project',
    label: 'Update project',
    access: 'write',
    permission: 'project.update',
    description: "Rename a project or change its description. Only send the fields that change (null = keep).",
    input: z.object({ project, name: z.string().max(100).nullable(), description: z.string().max(2000).nullable() }),
    execute: async (ctx, { project: key, name, description }) => {
      const p = await updateProject(ctx.deps, ctx.caller, projectOf(ctx, key), {
        ...(name !== null ? { name } : {}),
        ...(description !== null ? { description } : {}),
      })
      return { ok: true, key: p.key, name: p.name, description: p.description }
    },
  }),
  defineChatTool({
    name: 'add_member',
    label: 'Add member',
    access: 'write',
    permission: 'project.manage_members',
    description: 'Add a person (user id from find_people) to the project with a role.',
    input: z.object({ project, userId: z.string(), role: z.enum(PROJECT_ROLES) }),
    execute: async (ctx, { project: key, userId, role }) => {
      const p = await projectService.addMember(ctx.deps, ctx.caller, projectOf(ctx, key), { userId, role })
      return { ok: true, members: p.members.map((m) => ({ ...person(m.user), role: m.role })) }
    },
  }),
  defineChatTool({
    name: 'update_member_role',
    label: 'Change member role',
    access: 'write',
    permission: 'project.manage_members',
    description: "Change a member's project role.",
    input: z.object({ project, userId: z.string(), role: z.enum(PROJECT_ROLES) }),
    execute: async (ctx, { project: key, userId, role }) => {
      const p = await projectService.updateMember(ctx.deps, ctx.caller, projectOf(ctx, key), userId, { role })
      return { ok: true, members: p.members.map((m) => ({ ...person(m.user), role: m.role })) }
    },
  }),
  defineChatTool({
    name: 'remove_member',
    label: 'Remove member',
    access: 'write',
    permission: 'project.manage_members',
    description: 'Remove a person from the project.',
    input: z.object({ project, userId: z.string() }),
    execute: async (ctx, { project: key, userId }) => {
      const p = await projectService.removeMember(ctx.deps, ctx.caller, projectOf(ctx, key), userId)
      return { ok: true, members: p.members.map((m) => ({ ...person(m.user), role: m.role })) }
    },
  }),
  defineChatTool({
    name: 'archive_project',
    label: 'Archive project',
    access: 'write',
    permission: 'project.update',
    description: 'Archive a project (an org admin can restore it from Settings → Archived).',
    input: z.object({ project }),
    execute: async (ctx, { project: key }) => {
      const k = projectOf(ctx, key)
      await archiveProject(ctx.deps, ctx.caller, k)
      return { ok: true, archived: k }
    },
  }),
]
