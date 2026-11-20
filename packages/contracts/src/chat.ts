// Platform Chat: specialist assistants that read and manage the platform through the API's own services, and
// build new things (workflows, projects, agents, skills, stories) as DRAFTS the user reviews and submits.
// Shared by the API (validation), the web /chat page and the VS Code chat panel (types + the review forms).
//
// Draft data schemas are also the input schemas of the `update_draft` tool the model calls, so every field is
// required (optional values are nullable) — strict tool-calling schemas reject optional properties.

import { z } from 'zod'
import { PROJECT_ROLES } from './rbac'
import { STORY_PRIORITIES } from './stories'

// ─── Config, models, assistants ─────────────────────────────────────────────────────────────────

export const CHAT_TOOL_MODES = ['auto', 'read-only', 'ask'] as const
export type ChatToolMode = (typeof CHAT_TOOL_MODES)[number]

export const CHAT_TOOL_MODE_LABELS: Record<ChatToolMode, { label: string; description: string }> = {
  auto: { label: 'Auto', description: 'Reads run freely; every change asks for your approval.' },
  'read-only': { label: 'Read-only', description: 'The assistant can look things up but never change anything.' },
  ask: { label: 'Ask every time', description: 'Every tool call, reads included, waits for your approval.' },
}

export const ChatModelSchema = z.object({
  /** Azure OpenAI deployment name. */
  id: z.string(),
  label: z.string(),
  /** Context window in tokens — drives the usage ring. */
  contextWindow: z.number().int().positive(),
})
export type ChatModel = z.infer<typeof ChatModelSchema>

export const ChatConfigSchema = z.object({
  enabled: z.boolean(),
  /** Why chat is off (e.g. no Azure OpenAI key configured), when it is. */
  reason: z.string().nullable(),
  models: z.array(ChatModelSchema),
  defaultModel: z.string().nullable(),
})
export type ChatConfig = z.infer<typeof ChatConfigSchema>

export const DRAFT_KINDS = ['workflow', 'project', 'agent', 'skill', 'stories'] as const
export type DraftKind = (typeof DRAFT_KINDS)[number]

export const ChatAgentSummarySchema = z.object({
  /** Picker id, e.g. `workflows`. `default` is the general assistant. */
  name: z.string(),
  label: z.string(),
  /** Lucide icon name (the web maps it; the extension maps it to a codicon). */
  icon: z.string(),
  description: z.string(),
  /** `project`: works inside one project (the project chip is required). `org`: across projects. */
  scope: z.enum(['project', 'org']),
  /** What it builds through Review & submit; null for assistants that only read or manage. */
  draft: z.enum(DRAFT_KINDS).nullable(),
  /** Placeholder for the composer when this assistant is picked. */
  placeholder: z.string(),
})
export type ChatAgentSummary = z.infer<typeof ChatAgentSummarySchema>

export const ChatToolInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  access: z.enum(['read', 'write']),
  /** False when the user's role (or the tool mode) rules it out; `reason` says why. */
  available: z.boolean(),
  reason: z.string().nullable(),
})
export type ChatToolInfo = z.infer<typeof ChatToolInfoSchema>

// ─── Threads & messages ────────────────────────────────────────────────────────────────────────

export const ChatThreadSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  agent: z.string(),
  projectKey: z.string().nullable(),
  model: z.string().nullable(),
  updatedAt: z.string(),
})
export type ChatThreadSummary = z.infer<typeof ChatThreadSummarySchema>

export const CreateChatThreadInputSchema = z.object({
  agent: z.string().min(1).max(60),
  projectKey: z.string().min(1).max(20).nullable().default(null),
  model: z.string().max(120).nullable().default(null),
})
export type CreateChatThreadInput = z.input<typeof CreateChatThreadInputSchema>

export const UpdateChatThreadInputSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  agent: z.string().min(1).max(60).optional(),
  projectKey: z.string().min(1).max(20).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
})
export type UpdateChatThreadInput = z.infer<typeof UpdateChatThreadInputSchema>

/** Usage and model of one assistant message (AI SDK message metadata). */
export const ChatMessageMetadataSchema = z.object({
  model: z.string().optional(),
  createdAt: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
})
export type ChatMessageMetadata = z.infer<typeof ChatMessageMetadataSchema>

/**
 * One send. Clients post only the newest message (a new user message, or the assistant message updated with
 * tool approvals / answers); the server holds the history.
 */
export const ChatRequestSchema = z.object({
  threadId: z.string().uuid(),
  /** An AI SDK UIMessage — validated by the server with the toolset in force. */
  message: z.object({ id: z.string().min(1), role: z.enum(['user', 'assistant']), parts: z.array(z.unknown()) }).passthrough(),
  agent: z.string().min(1).max(60),
  projectKey: z.string().min(1).max(20).nullable(),
  model: z.string().max(120).nullable(),
  toolMode: z.enum(CHAT_TOOL_MODES).default('auto'),
  disabledTools: z.array(z.string().max(80)).max(200).default([]),
})
export type ChatRequest = z.input<typeof ChatRequestSchema>

// ─── Interaction tools (resolved by the user in the UI) ─────────────────────────────────────────

export const ASK_USER_TOOL = 'ask_user'
export const HANDOFF_TOOL = 'handoff'
export const UPDATE_DRAFT_TOOL = 'update_draft'
/** Tools the client answers (no server execute). */
export const CLIENT_RESOLVED_TOOLS = [ASK_USER_TOOL, HANDOFF_TOOL] as const

export const AskUserInputSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().describe('Short id for the question, e.g. "region".'),
        question: z.string(),
        options: z
          .array(z.string())
          .describe('A few concrete answers to click. Empty when the answer is genuinely free text. Never add "Other".'),
        defaultValue: z.string().nullable().describe('Your recommended option, or null.'),
      }),
    )
    .min(1)
    .max(6),
})
export type AskUserInput = z.infer<typeof AskUserInputSchema>

export const AskUserOutputSchema = z.object({
  answers: z.array(z.object({ id: z.string(), question: z.string(), answer: z.string() })),
  /** The user skipped: proceed with your recommended defaults. */
  skipped: z.boolean(),
})
export type AskUserOutput = z.infer<typeof AskUserOutputSchema>

export const HandoffInputSchema = z.object({
  agent: z.string().describe('The specialist to continue with, e.g. "workflows".'),
  brief: z.string().describe('What the user wants, in one or two sentences — it becomes their first message to the specialist.'),
})
export type HandoffInput = z.infer<typeof HandoffInputSchema>

export const HandoffOutputSchema = z.object({ accepted: z.boolean() })

// ─── Drafts ─────────────────────────────────────────────────────────────────────────────────────

export const DRAFT_SDLC_STEPS = ['design', 'implement', 'review', 'release'] as const

const nullableText = (max: number) => z.string().max(max).nullable()

export const WorkflowDraftDataSchema = z.object({
  name: z.string().max(100).describe('Workflow name, e.g. "Hotfix delivery".'),
  description: z.string().max(2000).describe('One or two sentences: when to use this workflow.'),
  trigger: z.enum(['manual', 'issue']).describe('manual: a developer picks up a story. issue: seeded from an Azure Boards work item.'),
  setAsDefault: z.boolean().describe('Make it the project default workflow.'),
  steps: z
    .array(
      z.object({
        id: z.string().max(60).describe('kebab-case id, unique in the workflow. Keep existing ids when editing.'),
        kind: z.enum(['agent', 'approval', 'gate']).describe('agent: an AI agent does work. approval: a human approves. gate: quality evaluation.'),
        label: z.string().max(80),
        agentSlug: nullableText(100).describe('Agent steps: catalog agent slug (from list_agents). null if not decided.'),
        skills: z.array(z.string().max(100)).max(20).describe('Agent steps: skill slugs (from list_skills). Empty otherwise.'),
        sdlcStep: z.enum(DRAFT_SDLC_STEPS).nullable().describe('Agent and gate steps: the SDLC stage. null otherwise.'),
        question: nullableText(300).describe('Approval steps: the question the approver answers. null otherwise.'),
      }),
    )
    .max(30),
})
export type WorkflowDraftDataInput = z.infer<typeof WorkflowDraftDataSchema>

export const ProjectDraftDataSchema = z.object({
  name: z.string().max(100),
  key: nullableText(10).describe('2–10 letters/digits starting with a letter (e.g. PAY). null = generate from the name.'),
  description: z.string().max(2000),
  setup: z
    .enum(['workspace', 'repository', 'none'])
    .describe('workspace: blank workspace held by the platform. repository: import a GitHub/Azure Repos repository. none: no code.'),
  repositoryUrl: nullableText(500).describe('setup=repository: the repository URL. null otherwise.'),
  defaultBranch: nullableText(250).describe('setup=repository: branch to use; null = the remote default.'),
  connectionId: nullableText(60).describe('setup=repository: Git connection id (from list_git_connections), or null to match by owner.'),
})
export type ProjectDraftDataInput = z.infer<typeof ProjectDraftDataSchema>

export const AgentDraftDataSchema = z.object({
  name: z.string().max(100),
  slug: z.string().max(60).describe('kebab-case id, unique in the project, e.g. "security-reviewer".'),
  description: z.string().max(500).describe('One line: what the agent does and when to use it.'),
  category: z.string().max(40).describe('e.g. planning, implementation, quality, documentation, release.'),
  sdlcStage: z.enum(DRAFT_SDLC_STEPS),
  tools: z.array(z.string().max(80)).max(40).describe('Explicit tool allow-list, e.g. read_file, write_file, run_command.'),
  model: nullableText(120).describe('Model the agent asks for; null = the harness default.'),
  minProjectRole: z.enum(PROJECT_ROLES).nullable().describe('Minimum project role to use it; null = anyone on the project.'),
  instructions: z.string().max(20_000).describe('The agent prompt, in markdown.'),
})
export type AgentDraftDataInput = z.infer<typeof AgentDraftDataSchema>

export const SkillDraftDataSchema = z.object({
  name: z.string().max(100),
  slug: z.string().max(60).describe('kebab-case id, unique in the project.'),
  description: z.string().max(500).describe('One line: what the skill gives an agent and when to load it.'),
  tools: z.array(z.string().max(80)).max(40).describe('Tools the skill needs (allowed-tools).'),
  instructions: z.string().max(20_000).describe('The SKILL.md body, in markdown.'),
})
export type SkillDraftDataInput = z.infer<typeof SkillDraftDataSchema>

export const StoriesDraftDataSchema = z.object({
  stories: z
    .array(
      z.object({
        title: z.string().max(200),
        description: z.string().max(10_000).describe('User-story text ("As a … I want … so that …") plus context.'),
        acceptanceCriteria: z.array(z.string().max(500)).max(30),
        priority: z.enum(STORY_PRIORITIES),
        status: z.enum(['draft', 'ready']),
        labels: z.array(z.string().max(32)).max(10),
        dueDate: nullableText(10).describe('YYYY-MM-DD or null.'),
        tasks: z.array(z.object({ title: z.string().max(200), description: z.string().max(10_000) })).max(30),
      }),
    )
    .max(25),
})
export type StoriesDraftDataInput = z.infer<typeof StoriesDraftDataSchema>

export const DRAFT_DATA_SCHEMAS = {
  workflow: WorkflowDraftDataSchema,
  project: ProjectDraftDataSchema,
  agent: AgentDraftDataSchema,
  skill: SkillDraftDataSchema,
  stories: StoriesDraftDataSchema,
} as const satisfies Record<DraftKind, z.ZodTypeAny>

export type DraftDataByKind = { [K in DraftKind]: z.infer<(typeof DRAFT_DATA_SCHEMAS)[K]> }

export const DRAFT_STATUSES = ['open', 'submitted', 'discarded'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]

/** What a submitted draft created or changed — enough for each client to link to it. */
export const DraftRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workflow'), projectKey: z.string(), id: z.string() }),
  z.object({ type: z.literal('project'), projectKey: z.string() }),
  z.object({ type: z.literal('agent'), projectKey: z.string(), slug: z.string(), kind: z.enum(['agent', 'skill']) }),
  z.object({ type: z.literal('stories'), projectKey: z.string(), numbers: z.array(z.number().int()) }),
])
export type DraftRef = z.infer<typeof DraftRefSchema>

export const DraftResultSchema = z.object({ label: z.string(), ref: DraftRefSchema })
export type DraftResult = z.infer<typeof DraftResultSchema>

export const ChatDraftSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  kind: z.enum(DRAFT_KINDS),
  projectKey: z.string().nullable(),
  /** Editing an existing item: its id (workflow) or slug (agent/skill) or key (project). Null = create new. */
  targetId: z.string().nullable(),
  targetLabel: z.string().nullable(),
  data: z.unknown(),
  openQuestions: z.array(z.string()),
  ready: z.boolean(),
  status: z.enum(DRAFT_STATUSES),
  result: DraftResultSchema.nullable(),
  version: z.number().int(),
  updatedAt: z.string(),
})
export type ChatDraft = z.infer<typeof ChatDraftSchema>

export const UpdateChatDraftInputSchema = z.object({
  /** The version the edit is based on; a stale one is rejected with 409. */
  version: z.number().int(),
  data: z.unknown(),
})
export type UpdateChatDraftInput = z.infer<typeof UpdateChatDraftInputSchema>

export const ChatThreadDetailSchema = z.object({
  thread: ChatThreadSummarySchema,
  /** AI SDK UIMessages, oldest first. */
  messages: z.array(z.object({ id: z.string(), role: z.string(), parts: z.array(z.unknown()) }).passthrough()),
  drafts: z.array(ChatDraftSchema),
})
export type ChatThreadDetail = z.infer<typeof ChatThreadDetailSchema>

/** The data part appended to the thread when a draft is submitted. */
export const DRAFT_SUBMITTED_PART = 'data-draft-submitted'
export const DraftSubmittedDataSchema = z.object({ draftId: z.string(), kind: z.enum(DRAFT_KINDS), label: z.string(), ref: DraftRefSchema })
export type DraftSubmittedData = z.infer<typeof DraftSubmittedDataSchema>

export const DRAFT_KIND_LABELS: Record<DraftKind, { title: string; noun: string }> = {
  workflow: { title: 'New workflow', noun: 'workflow' },
  project: { title: 'New project', noun: 'project' },
  agent: { title: 'New agent', noun: 'agent' },
  skill: { title: 'New skill', noun: 'skill' },
  stories: { title: 'New stories', noun: 'stories' },
}

// ─── Review forms (rendered by both clients from these descriptors) ──────────────────────────────

/** Where a select's options come from when they aren't fixed. Clients resolve these from existing endpoints. */
export type DraftOptionSource = 'agents' | 'skills' | 'connections'

export type DraftField =
  | { key: string; label: string; type: 'text' | 'textarea' | 'markdown' | 'date' | 'switch'; help?: string; placeholder?: string }
  | { key: string; label: string; type: 'select'; options?: { value: string; label: string }[]; source?: DraftOptionSource; nullable?: boolean; help?: string }
  | { key: string; label: string; type: 'multiselect'; source: DraftOptionSource; help?: string }
  | { key: string; label: string; type: 'list' | 'tags'; help?: string; placeholder?: string }
  | { key: string; label: string; type: 'objectList'; itemLabel: string; titleKey: string; fields: DraftFormField[]; help?: string; newItem: Record<string, unknown> }

export interface DraftFieldCondition {
  key: string
  equals: string[]
}

/** A field plus an optional condition on a sibling value (e.g. repository URL only when setup = repository). */
export type DraftFormField = DraftField & { showWhen?: DraftFieldCondition }

const opts = (values: readonly string[], labels: Record<string, string> = {}) =>
  values.map((v) => ({ value: v, label: labels[v] ?? v.charAt(0).toUpperCase() + v.slice(1).replace(/[-_]/g, ' ') }))

export const DRAFT_FORMS: Record<DraftKind, DraftFormField[]> = {
  workflow: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'trigger', label: 'Starts when', type: 'select', options: opts(['manual', 'issue'], { manual: 'A story is picked up', issue: 'An Azure Boards work item is picked' }) },
    { key: 'setAsDefault', label: 'Make it the project default', type: 'switch' },
    {
      key: 'steps',
      label: 'Steps',
      type: 'objectList',
      itemLabel: 'step',
      titleKey: 'label',
      newItem: { id: '', kind: 'agent', label: 'New step', agentSlug: null, skills: [], sdlcStep: null, question: null },
      fields: [
        { key: 'label', label: 'Label', type: 'text' },
        { key: 'kind', label: 'Kind', type: 'select', options: opts(['agent', 'approval', 'gate'], { agent: 'Agent', approval: 'Human approval', gate: 'Quality gate' }) },
        { key: 'agentSlug', label: 'Agent', type: 'select', source: 'agents', nullable: true, showWhen: { key: 'kind', equals: ['agent'] } },
        { key: 'skills', label: 'Skills', type: 'multiselect', source: 'skills', showWhen: { key: 'kind', equals: ['agent'] } },
        { key: 'sdlcStep', label: 'SDLC stage', type: 'select', options: opts(DRAFT_SDLC_STEPS), nullable: true, showWhen: { key: 'kind', equals: ['agent', 'gate'] } },
        { key: 'question', label: 'Approval question', type: 'text', showWhen: { key: 'kind', equals: ['approval'] } },
      ],
    },
  ],
  project: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'key', label: 'Key', type: 'text', help: 'Leave empty to generate one from the name.', placeholder: 'PAY' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'setup', label: 'Code', type: 'select', options: opts(['workspace', 'repository', 'none'], { workspace: 'Blank workspace', repository: 'Import a repository', none: 'No code yet' }) },
    { key: 'repositoryUrl', label: 'Repository URL', type: 'text', showWhen: { key: 'setup', equals: ['repository'] } },
    { key: 'defaultBranch', label: 'Branch', type: 'text', help: 'Empty = the remote default.', showWhen: { key: 'setup', equals: ['repository'] } },
    { key: 'connectionId', label: 'Git connection', type: 'select', source: 'connections', nullable: true, showWhen: { key: 'setup', equals: ['repository'] } },
  ],
  agent: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'slug', label: 'Slug', type: 'text', help: 'kebab-case id used in workflows.' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'category', label: 'Category', type: 'text' },
    { key: 'sdlcStage', label: 'SDLC stage', type: 'select', options: opts(DRAFT_SDLC_STEPS) },
    { key: 'tools', label: 'Tools', type: 'tags', placeholder: 'read_file' },
    { key: 'model', label: 'Model', type: 'text', help: 'Empty = the harness default.' },
    { key: 'minProjectRole', label: 'Who may use it', type: 'select', options: opts(PROJECT_ROLES), nullable: true, help: 'Empty = anyone on the project.' },
    { key: 'instructions', label: 'Instructions', type: 'markdown' },
  ],
  skill: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'slug', label: 'Slug', type: 'text' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'tools', label: 'Allowed tools', type: 'tags' },
    { key: 'instructions', label: 'SKILL.md', type: 'markdown' },
  ],
  stories: [
    {
      key: 'stories',
      label: 'Stories',
      type: 'objectList',
      itemLabel: 'story',
      titleKey: 'title',
      newItem: { title: 'New story', description: '', acceptanceCriteria: [], priority: 'medium', status: 'draft', labels: [], dueDate: null, tasks: [] },
      fields: [
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'description', label: 'Description', type: 'textarea' },
        { key: 'acceptanceCriteria', label: 'Acceptance criteria', type: 'list' },
        { key: 'priority', label: 'Priority', type: 'select', options: opts(STORY_PRIORITIES) },
        { key: 'status', label: 'Status', type: 'select', options: opts(['draft', 'ready']) },
        { key: 'labels', label: 'Labels', type: 'tags' },
        { key: 'dueDate', label: 'Due date', type: 'date' },
        {
          key: 'tasks',
          label: 'Tasks',
          type: 'objectList',
          itemLabel: 'task',
          titleKey: 'title',
          newItem: { title: 'New task', description: '' },
          fields: [
            { key: 'title', label: 'Title', type: 'text' },
            { key: 'description', label: 'Description', type: 'textarea' },
          ],
        },
      ],
    },
  ],
}

/** An empty draft of each kind — what the review form shows before the assistant has saved anything. */
export const EMPTY_DRAFT_DATA: DraftDataByKind = {
  workflow: { name: '', description: '', trigger: 'manual', setAsDefault: false, steps: [] },
  project: { name: '', key: null, description: '', setup: 'workspace', repositoryUrl: null, defaultBranch: null, connectionId: null },
  agent: { name: '', slug: '', description: '', category: 'general', sdlcStage: 'implement', tools: [], model: null, minProjectRole: null, instructions: '' },
  skill: { name: '', slug: '', description: '', tools: [], instructions: '' },
  stories: { stories: [] },
}

/** Portfolio overview row (GET /portfolio): one per project the caller can see. */
export const PortfolioProjectSchema = z.object({
  key: z.string(),
  name: z.string(),
  myRole: z.enum(PROJECT_ROLES).nullable(),
  stories: z.object({
    total: z.number().int(),
    byStatus: z.record(z.number().int()),
    blocked: z.number().int(),
    overdue: z.number().int(),
    unassignedReady: z.number().int(),
  }),
  activeRuns: z.number().int(),
})
export type PortfolioProject = z.infer<typeof PortfolioProjectSchema>
