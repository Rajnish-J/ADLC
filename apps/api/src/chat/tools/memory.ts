// Project and story memory: search it, add notes, and curate (promote, accept/reject, pin, archive).

import { z } from 'zod'
import { CreateMemoryInputSchema, MEMORY_KINDS, MEMORY_STATUSES, type MemoryItem } from '@sdlc/contracts'
import { parse } from '../../http'
import * as memoryService from '../../services/memory'
import { clip, defineChatTool, projectOf, PROJECT_FIELD_DESCRIPTION } from './kit'

const project = z.string().nullable().describe(PROJECT_FIELD_DESCRIPTION)
const memoryId = z.string().describe('Memory item id (from list_memory).')
const NOTE_KINDS = ['note', 'decision', 'convention', 'learning'] as const

const item = (m: MemoryItem) => ({
  id: m.id,
  scope: m.scope,
  story: m.storyKey,
  kind: m.kind,
  status: m.status,
  title: m.title,
  content: clip(m.content, 1500),
  tags: m.tags,
  pinned: m.pinned,
  author: m.author?.displayName ?? null,
  createdAt: m.createdAt,
})

export const memoryTools = [
  defineChatTool({
    name: 'list_memory',
    label: 'Search memory',
    access: 'read',
    description: "Project memory (decisions, conventions, learnings…) or one story's memory, optionally full-text searched.",
    input: z.object({
      project,
      storyNumber: z.number().int().positive().nullable().describe("A story's own memory; null = project memory."),
      query: z.string().nullable().describe('Full-text search; null = everything.'),
      status: z.enum(MEMORY_STATUSES).nullable(),
      kind: z.enum(MEMORY_KINDS).nullable(),
    }),
    execute: async (ctx, { project: key, storyNumber, query, status, kind }) => {
      const k = projectOf(ctx, key)
      const rows = storyNumber
        ? await memoryService.listStoryMemory(ctx.deps.db, ctx.caller.user, k, storyNumber)
        : await memoryService.listProjectMemory(ctx.deps.db, ctx.caller.user, k, {
            scope: 'project',
            ...(status ? { status } : {}),
            ...(kind ? { kind } : {}),
            ...(query ? { q: query } : {}),
          }, ctx.deps.memoryIndex)
      const filtered = storyNumber ? rows.filter((m) => (!status || m.status === status) && (!kind || m.kind === kind)) : rows
      return { total: filtered.length, items: filtered.slice(0, 40).map(item) }
    },
  }),
  defineChatTool({
    name: 'get_project_profile',
    label: 'Read project profile',
    access: 'read',
    description:
      "The project's profile, written from its repository by the Project profiler: what the project is, its tech stack, architecture, status, developer guide and integrations, plus any update waiting for review.",
    input: z.object({ project }),
    execute: async (ctx, { project: key }) => {
      const profiles = ctx.deps.profiles
      if (!profiles) return { available: false, reason: 'Project profiles are not available in this context.' }
      const state = await profiles.state(ctx.caller.user, projectOf(ctx, key))
      const current = state.current
      return {
        available: Boolean(current?.content),
        hint: current ? undefined : state.hasRepository ? 'No profile yet — a lead can generate one from the Memory page.' : 'Link a repository first, then generate the profile from the Memory page.',
        version: current?.version ?? null,
        branch: current?.branch ?? null,
        aiWritten: current?.aiWritten ?? null,
        profile: current?.content ? clip(current.markdown, 12_000) : null,
        pendingUpdate: state.pending ? { status: state.pending.status, version: state.pending.version, runs: state.pending.runIds.length } : null,
      }
    },
  }),
  defineChatTool({
    name: 'add_project_memory',
    label: 'Add project memory',
    access: 'write',
    permission: 'memory.curate',
    description: 'Record a project-level memory item (a decision, convention or learning every story should know).',
    input: z.object({
      project,
      kind: z.enum(NOTE_KINDS),
      title: z.string().max(200),
      content: z.string().max(20_000).describe('Markdown.'),
      tags: z.array(z.string().max(40)).max(10),
      pinned: z.boolean().describe('Pinned items are always given to agents.'),
    }),
    execute: async (ctx, { project: key, ...input }) =>
      item(await memoryService.addProjectMemory(ctx.deps, ctx.caller, projectOf(ctx, key), parse(CreateMemoryInputSchema, input))),
  }),
  defineChatTool({
    name: 'add_story_memory',
    label: 'Add story memory',
    access: 'write',
    permission: 'memory.write',
    description: "Record a memory item on one story (what was learned or decided while working on it).",
    input: z.object({
      project,
      storyNumber: z.number().int().positive(),
      kind: z.enum(NOTE_KINDS),
      title: z.string().max(200),
      content: z.string().max(20_000),
      tags: z.array(z.string().max(40)).max(10),
    }),
    execute: async (ctx, { project: key, storyNumber, ...input }) =>
      item(await memoryService.addStoryMemory(ctx.deps, ctx.caller, projectOf(ctx, key), storyNumber, parse(CreateMemoryInputSchema, input))),
  }),
  defineChatTool({
    name: 'promote_memory',
    label: 'Promote to project memory',
    access: 'write',
    permission: 'memory.write',
    description: 'Propose a story memory item for project memory (a lead accepts or rejects it).',
    input: z.object({ project, memoryId }),
    execute: async (ctx, { project: key, memoryId: id }) => item(await memoryService.promoteMemory(ctx.deps, ctx.caller, projectOf(ctx, key), id)),
  }),
  defineChatTool({
    name: 'decide_memory',
    label: 'Accept / reject memory',
    access: 'write',
    permission: 'memory.curate',
    description: 'Accept or reject a proposed project memory item.',
    input: z.object({ project, memoryId, accept: z.boolean(), comment: z.string().max(1000).nullable() }),
    execute: async (ctx, { project: key, memoryId: id, accept, comment }) =>
      item(await memoryService.decideMemory(ctx.deps, ctx.caller, projectOf(ctx, key), id, { accept, ...(comment ? { comment } : {}) })),
  }),
  defineChatTool({
    name: 'pin_memory',
    label: 'Pin / unpin memory',
    access: 'write',
    permission: 'memory.curate',
    description: 'Pin (always given to agents) or unpin a project memory item.',
    input: z.object({ project, memoryId, pinned: z.boolean() }),
    execute: async (ctx, { project: key, memoryId: id, pinned }) =>
      item(await memoryService.updateMemory(ctx.deps, ctx.caller, projectOf(ctx, key), id, { pinned })),
  }),
  defineChatTool({
    name: 'archive_memory',
    label: 'Archive memory',
    access: 'write',
    permission: 'memory.write',
    description: 'Archive a memory item that is no longer true.',
    input: z.object({ project, memoryId }),
    execute: async (ctx, { project: key, memoryId: id }) => item(await memoryService.archiveMemory(ctx.deps, ctx.caller, projectOf(ctx, key), id)),
  }),
]
