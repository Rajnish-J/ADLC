// Request and response shapes of the platform API (v1). Inputs are validated with these schemas on the server;
// clients use the inferred types. Dates travel as ISO-8601 strings.

import { z } from 'zod'
import { ProjectSettingsSchema } from './engines'
import { RepositoryBadgeSchema, RepositoryInputSchema } from './repo'
import { StoryExternalSchema } from './boards'
import type { WorkflowSpec } from '@sdlc/core'
import { ORG_ROLES, PERMISSIONS, PROJECT_ROLES } from './rbac'
import { STORY_PRIORITIES, STORY_STATUSES } from './stories'

// ─── Users & projects ────────────────────────────────────────────────────────────────────────────

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  orgRole: z.enum(ORG_ROLES),
})
export type User = z.infer<typeof UserSchema>

export const MeSchema = z.object({
  user: UserSchema,
  canCreateProject: z.boolean(),
})
export type Me = z.infer<typeof MeSchema>

export const MemberSchema = z.object({
  user: UserSchema,
  role: z.enum(PROJECT_ROLES),
  addedAt: z.string(),
})
export type Member = z.infer<typeof MemberSchema>

/** Stories per board column — every status is always present. */
export const StoryCountsSchema = z.object({
  draft: z.number().int(),
  ready: z.number().int(),
  in_progress: z.number().int(),
  in_review: z.number().int(),
  done: z.number().int(),
}) satisfies z.ZodType<Record<(typeof STORY_STATUSES)[number], number>>

export const ProjectSummarySchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  /** The caller's role in the project; null for an org admin who isn't a member. */
  myRole: z.enum(PROJECT_ROLES).nullable(),
  storyCounts: StoryCountsSchema,
  /** The linked GitHub / Azure Repos repository; null when none is linked. */
  repository: RepositoryBadgeSchema.nullable().default(null),
  /** Engine defaults and limits for story sessions. */
  settings: ProjectSettingsSchema,
})
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>

export const ProjectDetailSchema = ProjectSummarySchema.extend({
  repoUrl: z.string().nullable(),
  createdAt: z.string(),
  members: z.array(MemberSchema),
  /** Project-level permissions the caller holds — for showing/hiding UI. The API still checks every call. */
  permissions: z.array(z.enum(PERMISSIONS)),
  /** Roles the caller may grant when adding or changing members. */
  assignableRoles: z.array(z.enum(PROJECT_ROLES)),
})
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/

/**
 * A key suggestion for a project name, Jira-style: the initials of a multi-word name ("Payments Service" → "PS"),
 * or the start of a single word ("Restaurant" → "RESTAU"). Always matches PROJECT_KEY_PATTERN when the name has a
 * letter; empty otherwise.
 */
export function suggestProjectKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9\s_-]/g, '')
    .split(/[\s_-]+/)
    .filter(Boolean)
  const firstLetter = words.findIndex((w) => /^[A-Za-z]/.test(w))
  if (firstLetter < 0) return ''
  const usable = words.slice(firstLetter)
  let key = usable.length >= 2 ? usable.map((w) => w[0]).join('') : usable[0].slice(0, 6)
  if (key.length < 2) key = (usable[0] + (usable[1] ?? '')).slice(0, 2)
  if (key.length < 2) key = key.padEnd(2, 'X')
  return key.toUpperCase().slice(0, 10)
}

export const CreateProjectInputSchema = z
  .object({
    /** Generated from the name (and made unique) when omitted. */
    key: z
      .string()
      .trim()
      .transform((k) => k.toUpperCase())
      .pipe(z.string().regex(PROJECT_KEY_PATTERN, '2–10 letters or digits, starting with a letter (e.g. PAY)'))
      .optional(),
    name: z.string().trim().min(1, 'Enter a project name.').max(100),
    description: z.string().trim().max(2000).default(''),
    /** GitHub or Azure Repos repository to clone into the platform. */
    repository: RepositoryInputSchema.optional(),
    /** Start with an empty workspace held by the platform (no remote until it is published). */
    workspace: z.boolean().optional(),
  })
  .refine((v) => !(v.workspace && v.repository), { message: 'Pick a repository or a blank workspace, not both.', path: ['workspace'] })
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>

export const AddMemberInputSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(PROJECT_ROLES),
})
export type AddMemberInput = z.infer<typeof AddMemberInputSchema>

export const UpdateMemberInputSchema = z.object({ role: z.enum(PROJECT_ROLES) })
export type UpdateMemberInput = z.infer<typeof UpdateMemberInputSchema>

// ─── Stories ─────────────────────────────────────────────────────────────────────────────────────

export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  text: z.string().trim().min(1).max(500),
  met: z.boolean(),
})
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>

export const MAX_STORY_LABELS = 10
export const MAX_LABEL_LENGTH = 32

/** "Needs Migration " → "needs-migration": labels are lowercase, hyphenated tags so filters never split on case. */
export function normalizeLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s,]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

export const StoryLabelSchema = z
  .string()
  .transform(normalizeLabel)
  .pipe(z.string().min(1, 'A label cannot be empty.').max(MAX_LABEL_LENGTH, `Labels are at most ${MAX_LABEL_LENGTH} characters.`))

export const StoryLabelsSchema = z
  .array(StoryLabelSchema)
  .transform((labels) => [...new Set(labels)])
  .pipe(z.array(z.string()).max(MAX_STORY_LABELS, `A story has at most ${MAX_STORY_LABELS} labels.`))

/** A calendar date, `YYYY-MM-DD` (no time, no timezone). */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d))
    return y >= 2000 && y <= 2100 && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  }, 'Not a valid date.')

/** The latest run of a story or task: its status, harness, and the workflow it was started with. */
export const RunSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  engine: z.string().nullable(),
  startedAt: z.string(),
  workflowId: z.string().nullable().default(null),
  workflowName: z.string().nullable().default(null),
})
export type RunSummary = z.infer<typeof RunSummarySchema>

export const StorySchema = z.object({
  id: z.string().uuid(),
  projectKey: z.string(),
  number: z.number().int(),
  /** `PAY-42`. */
  key: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
  status: z.enum(STORY_STATUSES),
  priority: z.enum(STORY_PRIORITIES),
  isBlocked: z.boolean(),
  blockedReason: z.string().nullable(),
  /** Lowercase tags ("needs-migration"); filters on the board. */
  labels: z.array(z.string()).default([]),
  /** `YYYY-MM-DD`, or null when the story has no due date. */
  dueDate: z.string().nullable().default(null),
  /** Board order within a column (ascending), shared across the project; ties break on `number`. */
  rank: z.number().default(0),
  /** The Azure Boards work item this story is synced from; null for a story created on the platform. */
  external: StoryExternalSchema.nullable().default(null),
  assignee: UserSchema.nullable(),
  createdBy: UserSchema,
  /** The story's latest run (not a task's): which workflow it was started with, in which harness, and how it went. */
  latestRun: RunSummarySchema.nullable().default(null),
  /** Optimistic-concurrency version; send it back as `version` when editing. */
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** What the caller may do with this story right now, computed server-side from the shared rules. */
  actions: z.object({
    canEdit: z.boolean(),
    canPickUp: z.boolean(),
    canAssign: z.boolean(),
    /** May add to the story's memory (developers: only on stories assigned to them). */
    canAddMemory: z.boolean(),
    /** May report code activity (working state, commits, agent runs) from VS Code against this story. */
    canReportWork: z.boolean(),
    transitions: z.array(z.object({ to: z.enum(STORY_STATUSES), label: z.string() })),
  }),
})
export type Story = z.infer<typeof StorySchema>

export const CreateStoryInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).default(''),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  priority: z.enum(STORY_PRIORITIES).default('medium'),
  /** New stories start as drafts unless the author marks them ready straight away. */
  status: z.enum(['draft', 'ready']).default('draft'),
  labels: StoryLabelsSchema.default([]),
  dueDate: IsoDateSchema.nullable().optional(),
})
export type CreateStoryInput = z.input<typeof CreateStoryInputSchema>

export const UpdateStoryInputSchema = z.object({
  /** The version the edit is based on; a stale version is rejected with 409. */
  version: z.number().int(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(10_000).optional(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(30).optional(),
  priority: z.enum(STORY_PRIORITIES).optional(),
  isBlocked: z.boolean().optional(),
  blockedReason: z.string().trim().max(500).nullable().optional(),
  /** Whoever may edit the story may change its labels. */
  labels: StoryLabelsSchema.optional(),
  /** A lead's call, like priority. Null clears it. */
  dueDate: IsoDateSchema.nullable().optional(),
})
export type UpdateStoryInput = z.infer<typeof UpdateStoryInputSchema>

export const TransitionInputSchema = z.object({ to: z.enum(STORY_STATUSES) })
export type TransitionInput = z.infer<typeof TransitionInputSchema>

/**
 * Where a drop on the board lands a story: its column (`to`) and, optionally, the cards it was dropped between
 * as the caller saw them. Without either anchor the story keeps its place in the order. Moving to another column
 * follows the same rules as a transition (or a pick-up, for Ready → In progress); reordering within a column
 * needs edit rights on the story.
 */
export const MoveStoryInputSchema = z.object({
  to: z.enum(STORY_STATUSES),
  afterId: z.string().uuid().nullable().optional(),
  beforeId: z.string().uuid().nullable().optional(),
})
export type MoveStoryInput = z.infer<typeof MoveStoryInputSchema>

export const AssignInputSchema = z.object({ userId: z.string().uuid().nullable() })
export type AssignInput = z.infer<typeof AssignInputSchema>

// ─── Agents & workflows ──────────────────────────────────────────────────────────────────────────

export const EXECUTION_TARGETS = ['local', 'server'] as const
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number]

export const AGENT_SOURCES = ['builtin', 'repo', 'platform'] as const
export type AgentSource = (typeof AGENT_SOURCES)[number]

export const AGENT_KINDS = ['agent', 'skill'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export const AgentSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  sdlcStage: z.string(),
  /** `local`: runs in the developer's VS Code against their checkout. `server`: runs on the backend. */
  executionTarget: z.enum(EXECUTION_TARGETS),
  /** Explicit tool allow-list — never "all tools". */
  tools: z.array(z.string()),
  /** Whether the agent is enabled for the project (project-scoped listings only). */
  enabled: z.boolean(),
  /** `builtin`: ships with the platform. `repo`: discovered in the project's codebase. `platform`: defined on the platform. */
  source: z.enum(AGENT_SOURCES),
  /** `agent` or `skill` (a reusable capability an agent can load). */
  kind: z.enum(AGENT_KINDS),
  /** Branch the agent was discovered on (repo agents only). */
  branch: z.string().nullable(),
  /** Minimum project role needed to use the agent; null when anyone on the project may. */
  requiredRole: z.enum(PROJECT_ROLES).nullable(),
  /** Whether the CALLER may use it. Restricted agents are still listed, but locked. */
  usable: z.boolean(),
  /** Where the definition lives: the repo-relative file path. */
  sourcePath: z.string().nullable(),
  /** Model the definition asks for (repo agents), if any. */
  model: z.string().nullable().default(null),
  /** Problems found when the definition was imported (repo agents); empty when it is fine. */
  issues: z.array(z.string()).default([]),
})
export type Agent = z.infer<typeof AgentSchema>

/** One agent with its full definition — the markdown body of its file — for the agent's own page. */
export const AgentDetailSchema = AgentSchema.extend({
  /** The agent's instructions, as markdown. */
  instructions: z.string(),
})
export type AgentDetail = z.infer<typeof AgentDetailSchema>

export const ToggleAgentInputSchema = z.object({ enabled: z.boolean() })
export type ToggleAgentInput = z.infer<typeof ToggleAgentInputSchema>

export const WorkflowSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  version: z.number().int(),
})
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>

export type WorkflowDetail = WorkflowSummary & { spec: WorkflowSpec }

/** Bind (or, with null, unbind) an agent to one agent step of a project workflow. */
export const SetStepAgentInputSchema = z.object({ agentSlug: z.string().regex(/^[a-z0-9-]+$/).max(200).nullable() })
export type SetStepAgentInput = z.infer<typeof SetStepAgentInputSchema>

/** Result of a mapping change: the step as it now stands and the workflow's new version. */
export const SetStepAgentResultSchema = z.object({
  workflowId: z.string().uuid(),
  nodeId: z.string(),
  agentSlug: z.string().nullable(),
  agentName: z.string().nullable(),
  version: z.number().int(),
})
export type SetStepAgentResult = z.infer<typeof SetStepAgentResultSchema>

// ─── Audit ───────────────────────────────────────────────────────────────────────────────────────

export const AuditEntrySchema = z.object({
  id: z.number().int(),
  action: z.string(),
  actor: UserSchema.nullable(),
  resourceType: z.string(),
  resourceId: z.string(),
  data: z.unknown(),
  via: z.string(),
  createdAt: z.string(),
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>

// ─── Errors ──────────────────────────────────────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>
