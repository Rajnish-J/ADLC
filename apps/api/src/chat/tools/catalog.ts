// The agent and skill catalog: read it, load a platform agent/skill into the draft to edit it (or any agent/skill
// as the starting point of a new one), enable/disable, delete platform ones.

import { z } from 'zod'
import type { AgentDraftDataInput, SkillDraftDataInput } from '@sdlc/contracts'
import { loadProjectAccess } from '../../access'
import * as agentService from '../../services/agents'
import { upsertDraft } from '../store'
import { clip, defineChatTool, projectOf, PROJECT_FIELD_DESCRIPTION } from './kit'

const project = z.string().nullable().describe(PROJECT_FIELD_DESCRIPTION)
const SDLC_STEPS = ['design', 'implement', 'review', 'release'] as const
const asStage = (s: string) => ((SDLC_STEPS as readonly string[]).includes(s) ? (s as (typeof SDLC_STEPS)[number]) : 'implement')

const listOf = (kind: 'agent' | 'skill') =>
  defineChatTool({
    name: kind === 'agent' ? 'list_agents' : 'list_skills',
    label: kind === 'agent' ? 'List agents' : 'List skills',
    access: 'read',
    description:
      kind === 'agent'
        ? "The project's agents: slug, name, description, source (builtin / repo / platform), enabled, usable by this user."
        : "The project's skills (capabilities an agent step can load): slug, name, description, source, enabled.",
    input: z.object({ project }),
    execute: async (ctx, { project: key }) => {
      const all = await agentService.listAgents(ctx.deps.db, ctx.caller.user, projectOf(ctx, key))
      return all
        .filter((a) => a.kind === kind)
        .map((a) => ({
          slug: a.slug,
          name: a.name,
          description: a.description,
          source: a.source,
          category: a.category,
          sdlcStage: a.sdlcStage,
          enabled: a.enabled,
          usable: a.usable,
          ...(a.requiredRole ? { requiredRole: a.requiredRole } : {}),
        }))
    },
  })

const loadIntoDraft = (kind: 'agent' | 'skill') =>
  defineChatTool({
    name: kind === 'agent' ? 'load_agent_into_draft' : 'load_skill_into_draft',
    label: kind === 'agent' ? 'Edit agent (draft)' : 'Edit skill (draft)',
    access: 'read',
    kind: 'draft',
    description: `Copy an existing ${kind} into the draft (replacing any open ${kind} draft). Platform ${kind}s can be edited in place; built-in and repository ones can only be used as the starting point of a NEW ${kind} (asCopy is forced). Then refine it with update_draft.`,
    input: z.object({ project, slug: z.string(), asCopy: z.boolean().describe(`true = a new ${kind} based on this one; false = edit it (platform ${kind}s only).`) }),
    execute: async (ctx, { project: key, slug, asCopy }) => {
      const k = projectOf(ctx, key)
      const access = await loadProjectAccess(ctx.deps.db, ctx.caller.user, k)
      const a = await agentService.getAgent(ctx.deps.db, ctx.caller.user, k, slug)
      if (a.kind !== kind) return { ok: false, error: `${a.name} is ${a.kind === 'skill' ? 'a skill' : 'an agent'}.` }
      const copy = asCopy || a.source !== 'platform'
      const newSlug = copy ? `${a.slug.replace(/^repo-/, '')}-custom` : a.slug
      const data: AgentDraftDataInput | SkillDraftDataInput =
        kind === 'agent'
          ? {
              name: copy ? `${a.name} (custom)` : a.name,
              slug: newSlug,
              description: a.description,
              category: a.category,
              sdlcStage: asStage(a.sdlcStage),
              tools: a.tools,
              model: a.model,
              minProjectRole: a.requiredRole,
              instructions: a.instructions,
            }
          : { name: copy ? `${a.name} (custom)` : a.name, slug: newSlug, description: a.description, tools: a.tools, instructions: a.instructions }
      const draft = await upsertDraft(ctx.deps.db, {
        threadId: ctx.threadId,
        kind,
        projectId: access.project.id,
        data,
        openQuestions: [],
        ready: false,
        target: copy ? null : { id: a.slug, label: a.name },
        replace: true,
      })
      return {
        ok: true,
        draftId: draft.id,
        mode: copy ? `create (based on ${a.source} ${kind} "${a.name}")` : `editing "${a.name}"`,
        data: { ...data, instructions: clip(data.instructions, 6000) },
      }
    },
  })

export const catalogTools = [
  listOf('agent'),
  listOf('skill'),
  defineChatTool({
    name: 'get_agent',
    label: 'Read agent or skill',
    access: 'read',
    description: 'One agent or skill with its full instructions (markdown), tools, model and access rule.',
    input: z.object({ project, slug: z.string() }),
    execute: async (ctx, { project: key, slug }) => {
      const a = await agentService.getAgent(ctx.deps.db, ctx.caller.user, projectOf(ctx, key), slug)
      return {
        slug: a.slug,
        name: a.name,
        kind: a.kind,
        source: a.source,
        sourcePath: a.sourcePath,
        description: a.description,
        category: a.category,
        sdlcStage: a.sdlcStage,
        tools: a.tools,
        model: a.model,
        requiredRole: a.requiredRole,
        enabled: a.enabled,
        usable: a.usable,
        issues: a.issues,
        instructions: clip(a.instructions, 8000),
      }
    },
  }),
  loadIntoDraft('agent'),
  loadIntoDraft('skill'),
  defineChatTool({
    name: 'set_agent_enabled',
    label: 'Enable / disable',
    access: 'write',
    permission: 'agent.configure',
    description: 'Enable or disable an agent or skill in the project. Disabling one a workflow step still uses is refused.',
    input: z.object({ project, slug: z.string(), enabled: z.boolean() }),
    execute: async (ctx, { project: key, slug, enabled }) => agentService.setAgentEnabled(ctx.deps, ctx.caller, projectOf(ctx, key), slug, enabled),
  }),
  defineChatTool({
    name: 'delete_platform_agent',
    label: 'Delete agent or skill',
    access: 'write',
    permission: 'agent.configure',
    description: 'Delete a platform agent or skill. Built-in and repository ones cannot be deleted here; one still used by a workflow step is refused.',
    input: z.object({ project, slug: z.string() }),
    execute: async (ctx, { project: key, slug }) => agentService.deletePlatformAgent(ctx.deps, ctx.caller, projectOf(ctx, key), slug),
  }),
]
