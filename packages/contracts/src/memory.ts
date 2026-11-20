// Story and project memory. Every story keeps its own memory (notes, decisions, learnings, run summaries); the
// useful parts roll up into project memory — proposed by anyone who may write the story's memory, accepted by
// a lead. Agents started on a story get both as "project knowledge" in their prompt.

import { z } from 'zod'
import { UserSchema } from './schemas'

export const MEMORY_SCOPES = ['story', 'project'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const MEMORY_KINDS = ['note', 'decision', 'convention', 'learning', 'summary'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  note: 'Note',
  decision: 'Decision',
  convention: 'Convention',
  learning: 'Learning',
  summary: 'Summary',
}

export const MEMORY_STATUSES = ['proposed', 'accepted', 'rejected', 'archived'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/**
 * Where an item came from: written by a person, captured from an agent run, the story-done roll-up, promoted, or
 * the project profile (one item per accepted profile version — the platform keeps it, earlier versions archived).
 */
export const MEMORY_SOURCES = ['manual', 'run', 'story_done', 'promotion', 'profile'] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

export const FileRefSchema = z.object({
  path: z.string().trim().min(1).max(500),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
})
export type FileRef = z.infer<typeof FileRefSchema>

export const MemoryItemSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(MEMORY_SCOPES),
  /** The story an item belongs to (story scope), or was promoted from / rolled up from (project scope). */
  storyKey: z.string().nullable(),
  storyNumber: z.number().int().nullable(),
  storyTitle: z.string().nullable(),
  kind: z.enum(MEMORY_KINDS),
  status: z.enum(MEMORY_STATUSES),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  fileRefs: z.array(FileRefSchema),
  source: z.enum(MEMORY_SOURCES),
  promotedFromId: z.string().uuid().nullable(),
  /** For a story item: the project item it was promoted into, if any (and that item's status). */
  promotion: z.object({ id: z.string().uuid(), status: z.enum(MEMORY_STATUSES) }).nullable(),
  author: UserSchema.nullable(),
  decidedBy: UserSchema.nullable(),
  decidedAt: z.string().nullable(),
  decisionComment: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The agent run that wrote this item, if one did. */
  runId: z.string().uuid().nullable().default(null),
  /** How many runs have been given this item. */
  usedByRuns: z.number().int().default(0),
  /** What the caller may do with this item right now. */
  actions: z.object({
    canEdit: z.boolean(),
    canPromote: z.boolean(),
    canDecide: z.boolean(),
    canPin: z.boolean(),
    canArchive: z.boolean(),
  }),
})
export type MemoryItem = z.infer<typeof MemoryItemSchema>

export const CreateMemoryInputSchema = z.object({
  kind: z.enum(MEMORY_KINDS).default('note'),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().max(20_000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  fileRefs: z.array(FileRefSchema).max(20).default([]),
  /** Project items only; needs memory.curate. */
  pinned: z.boolean().optional(),
  /** The agent run writing this item (only its owner may claim it), and the step it was in. */
  runId: z.string().uuid().optional(),
  stepId: z.string().max(200).optional(),
})
export type CreateMemoryInput = z.input<typeof CreateMemoryInputSchema>

export const UpdateMemoryInputSchema = z.object({
  kind: z.enum(MEMORY_KINDS).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  pinned: z.boolean().optional(),
})
export type UpdateMemoryInput = z.infer<typeof UpdateMemoryInputSchema>

export const DecideMemoryInputSchema = z.object({
  accept: z.boolean(),
  comment: z.string().trim().max(1000).optional(),
})
export type DecideMemoryInput = z.infer<typeof DecideMemoryInputSchema>

export const MemoryListQuerySchema = z.object({
  scope: z.enum(MEMORY_SCOPES).default('project'),
  status: z.enum(MEMORY_STATUSES).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  /** Full-text search over title and content. */
  q: z.string().trim().max(200).optional(),
})
export type MemoryListQuery = z.input<typeof MemoryListQuerySchema>

/** The memory an agent working on a story is given: Markdown plus the ids of the items it includes. */
export const MemoryContextSchema = z.object({
  markdown: z.string(),
  itemIds: z.array(z.string().uuid()),
  /** True when the AI model wrote a focused brief for this task (Project settings → Memory → AI & context). */
  curated: z.boolean().optional(),
  /** The model that curated it. */
  model: z.string().nullable().optional(),
  /** The accepted project profile version given with this context (null/absent: no profile was included). */
  profileVersion: z.number().int().nullable().optional(),
})
export type MemoryContext = z.infer<typeof MemoryContextSchema>

/**
 * Fetching memory for an agent run: `runId`/`stepId` record which items the run was given (only the run's owner
 * records anything); `q` is the quick fix's prompt, to find related project knowledge.
 */
export const MemoryContextQuerySchema = z.object({
  runId: z.string().uuid().optional(),
  stepId: z.string().max(200).optional(),
  via: z.enum(['context', 'tool']).default('context'),
  q: z.string().trim().max(4_000).optional(),
})
export type MemoryContextQuery = z.input<typeof MemoryContextQuerySchema>
