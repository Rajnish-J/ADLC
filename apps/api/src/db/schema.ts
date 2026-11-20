// Postgres schema (Drizzle): identity, projects and members, stories, the agent catalog, workflows, the
// append-only audit log, story/project memory, and the code activity the VS Code extension reports (live working
// state, commits, agent runs). Role ASSIGNMENTS are stored here; what each role may do is the constant map in
// @sdlc/contracts.

import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import {
  AGENT_KINDS,
  AGENT_SOURCES,
  EXECUTION_TARGETS,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_STATUSES,
  ORG_ROLES,
  PROJECT_ROLES,
  REPO_FILE_STATUSES,
  REPO_PROVIDERS,
  REPO_STATUSES,
  REPO_SYNC_STATUSES,
  REPO_SYNC_TRIGGERS,
  RUN_DRIVERS,
  RUN_ORIGINS,
  RUN_STATUSES,
  RUN_STEP_STATUSES,
  TASK_STATUSES,
  STORY_PRIORITIES,
  STORY_STATUSES,
} from '@sdlc/contracts'
import type {
  AcceptanceCriterion,
  ApprovalRecord,
  ChangedFile,
  EvaluationResult,
  FileRef,
  InstalledEngine,
  RepoSyncStats,
  RunCommit,
  RunMemoryVia,
  SkillUse,
  TaskExternalLink,
} from '@sdlc/contracts'
import type { WorkflowSpec } from '@sdlc/core'

export const orgRole = pgEnum('org_role', ORG_ROLES)
export const projectRole = pgEnum('project_role', PROJECT_ROLES)
export const storyStatus = pgEnum('story_status', STORY_STATUSES)
export const storyPriority = pgEnum('story_priority', STORY_PRIORITIES)
export const executionTarget = pgEnum('execution_target', EXECUTION_TARGETS)
export const agentSource = pgEnum('agent_source', AGENT_SOURCES)
export const agentKind = pgEnum('agent_kind', AGENT_KINDS)
export const memoryScope = pgEnum('memory_scope', MEMORY_SCOPES)
export const memoryKind = pgEnum('memory_kind', MEMORY_KINDS)
export const memoryStatus = pgEnum('memory_status', MEMORY_STATUSES)
export const memorySource = pgEnum('memory_source', MEMORY_SOURCES)
export const runStatus = pgEnum('run_status', RUN_STATUSES)
export const runStepStatus = pgEnum('run_step_status', RUN_STEP_STATUSES)
export const runOrigin = pgEnum('run_origin', RUN_ORIGINS)
export const runDriver = pgEnum('run_driver', RUN_DRIVERS)
export const stepPhase = pgEnum('step_phase', ['plan', 'execute'])
export const stepAssignmentStatus = pgEnum('step_assignment_status', ['pending', 'delivered', 'submitted', 'cancelled'])
export const taskStatus = pgEnum('task_status', TASK_STATUSES)
export const repoProvider = pgEnum('repo_provider', REPO_PROVIDERS)
export const repoStatus = pgEnum('repo_status', REPO_STATUSES)
export const repoSyncStatus = pgEnum('repo_sync_status', REPO_SYNC_STATUSES)
export const repoSyncTrigger = pgEnum('repo_sync_trigger', REPO_SYNC_TRIGGERS)
export const repoEntryType = pgEnum('repo_entry_type', ['file', 'dir'])
export const repoFileStatus = pgEnum('repo_file_status', REPO_FILE_STATUSES)

/** Postgres full-text search vector (a generated column, never written by the app). */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ...timestamps,
})

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    orgRole: orgRole('org_role').notNull().default('member'),
    /** Entra object id — set on first Entra sign-in. Identity is (tenant, oid), never email. */
    entraOid: text('entra_oid'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_org_email_uq').on(t.orgId, sql`lower(${t.email})`),
    uniqueIndex('users_entra_oid_uq').on(t.entraOid),
  ],
)

/**
 * Personal access tokens (`sdlc_pat_…`): how the VS Code extension calls the API as a user who signs in to the web
 * with Microsoft. Only the SHA-256 of the token is kept; the token is shown once, when it is created.
 */
export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** The token's first characters, shown in lists. */
    prefix: text('prefix').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('personal_access_tokens_hash_uq').on(t.tokenHash), index('personal_access_tokens_user_idx').on(t.userId)],
)

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** Short uppercase key, e.g. PAY — story keys are PAY-1, PAY-2, … */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    repoUrl: text('repo_url'),
    /** Engine defaults and limits (ProjectSettings); read through readProjectSettings(). */
    settings: jsonb('settings').notNull().default({}),
    nextStoryNumber: integer('next_story_number').notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('projects_org_key_uq').on(t.orgId, t.key)],
)

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectRole('role').notNull(),
    addedBy: uuid('added_by').references(() => users.id),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index('project_members_user_idx').on(t.userId)],
)

export const stories = pgTable(
  'stories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<AcceptanceCriterion[]>().notNull().default([]),
    status: storyStatus('status').notNull().default('draft'),
    priority: storyPriority('priority').notNull().default('medium'),
    /** Blocked is a flag, not a status, so the story keeps its column while blocked. */
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockedReason: text('blocked_reason'),
    /** Lowercase tags ("needs-migration"), normalised by the contract schema. */
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    dueDate: date('due_date', { mode: 'string' }),
    /**
     * Board order, one sequence per project: a column lists its stories by (rank, number). Status changes keep the
     * rank; only a drop with a position sets a new one (the midpoint of its new neighbours).
     */
    rank: doublePrecision('rank').notNull().default(0),
    assigneeId: uuid('assignee_id').references(() => users.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    version: integer('version').notNull().default(1),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stories_project_number_uq').on(t.projectId, t.number),
    index('stories_project_status_idx').on(t.projectId, t.status),
    index('stories_project_rank_idx').on(t.projectId, t.rank),
    index('stories_assignee_idx').on(t.assigneeId),
  ],
)

/**
 * Agent catalog. `builtin` agents ship with the platform (projectId null, seeded); `repo` agents and skills are
 * discovered in a project's codebase, per branch; `platform` ones are defined on the platform for one project.
 * `minProjectRole` restricts who may USE an agent (everyone on the project still sees it) — e.g. Wayfinder is
 * lead-and-above.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    source: agentSource('source').notNull().default('builtin'),
    kind: agentKind('kind').notNull().default('agent'),
    /** Set for repo-discovered agents; null for built-ins. */
    projectId: uuid('project_id').references((): AnyPgColumn => projects.id, { onDelete: 'cascade' }),
    branch: text('branch'),
    contentHash: text('content_hash'),
    minProjectRole: projectRole('min_project_role'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull(),
    sdlcStage: text('sdlc_stage').notNull(),
    executionTarget: executionTarget('execution_target').notNull().default('local'),
    /** Explicit allow-list; an agent never gets "all tools" by omission. */
    tools: text('tools').array().notNull().default(sql`'{}'::text[]`),
    instructions: text('instructions').notNull().default(''),
    sourcePath: text('source_path'),
    /** Model the definition asks for (repo agents). */
    model: text('model'),
    /** Problems found when a repo definition was imported; empty when it is fine. */
    issues: jsonb('issues').$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('agents_builtin_slug_uq').on(t.slug).where(sql`${t.projectId} is null`),
    uniqueIndex('agents_repo_slug_uq').on(t.projectId, t.branch, t.slug).where(sql`${t.projectId} is not null`),
    // Platform agents are a project's only branchless ones (repo agents always carry their branch, and a null
    // branch never collides above), so they get their own per-project slug index.
    uniqueIndex('agents_platform_slug_uq').on(t.projectId, t.slug).where(sql`${t.projectId} is not null and ${t.branch} is null`),
  ],
)

export const projectAgents = pgTable(
  'project_agents',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.agentId] })],
)

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for platform templates. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    isDefault: boolean('is_default').notNull().default(false),
    spec: jsonb('spec').$type<WorkflowSpec>().notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index('workflows_project_idx').on(t.projectId),
    uniqueIndex('workflows_one_default_per_project_uq')
      .on(t.projectId)
      .where(sql`${t.isDefault} and ${t.projectId} is not null`),
  ],
)

/** Append-only (a trigger rejects UPDATE/DELETE — see the custom migration). Written in the same transaction as the change. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    data: jsonb('data').notNull().default({}),
    /** Which client made the change: web, extension or system. */
    via: text('via').notNull().default('system'),
    ...timestamps,
  },
  (t) => [
    index('audit_project_created_idx').on(t.projectId, t.createdAt),
    index('audit_resource_idx').on(t.resourceType, t.resourceId),
  ],
)

// ─── Memory ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Story and project memory. Story items belong to one story; project items are shared by the whole project and
 * may point back at the story they were promoted or rolled up from (`story_id`). Auto-captured items carry a
 * `source_ref`, so capturing the same thing twice is a no-op.
 */
export const memoryItems = pgTable(
  'memory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: memoryScope('scope').notNull(),
    storyId: uuid('story_id').references(() => stories.id, { onDelete: 'set null' }),
    kind: memoryKind('kind').notNull().default('note'),
    status: memoryStatus('status').notNull().default('accepted'),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    /** Pinned project items are always given to agents. */
    pinned: boolean('pinned').notNull().default(false),
    fileRefs: jsonb('file_refs').$type<FileRef[]>().notNull().default([]),
    source: memorySource('source').notNull().default('manual'),
    sourceRef: text('source_ref'),
    promotedFromId: uuid('promoted_from_id').references((): AnyPgColumn => memoryItems.id, { onDelete: 'set null' }),
    /** The agent run that wrote the item (an agent's note, or a summary / learning captured when it ended). */
    runId: uuid('run_id').references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionComment: text('decision_comment'),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", ''))`,
    ),
  },
  (t) => [
    index('memory_project_scope_status_idx').on(t.projectId, t.scope, t.status),
    index('memory_story_idx').on(t.storyId),
    index('memory_run_idx').on(t.runId),
    index('memory_search_idx').using('gin', t.search),
    uniqueIndex('memory_source_ref_uq')
      .on(t.projectId, t.source, t.sourceRef)
      .where(sql`${t.sourceRef} is not null`),
  ],
)

// ─── Code activity reported by the VS Code extension ────────────────────────────────────────────

/** Each developer's latest uncommitted working state on a story — replaced on every report. */
export const storyWorkspaces = pgTable(
  'story_workspaces',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull(),
    headSha: text('head_sha'),
    ahead: integer('ahead').notNull().default(0),
    behind: integer('behind').notNull().default(0),
    files: jsonb('files').$type<ChangedFile[]>().notNull().default([]),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    patch: text('patch'),
    patchTruncated: boolean('patch_truncated').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storyId, t.userId] })],
)

/** Commits on a story's branch. Reporting the same commit again (same story + sha) updates it in place. */
export const storyCommits = pgTable(
  'story_commits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    branch: text('branch').notNull(),
    message: text('message').notNull().default(''),
    authorName: text('author_name').notNull().default(''),
    authorEmail: text('author_email').notNull().default(''),
    reportedBy: uuid('reported_by').references(() => users.id),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
    files: jsonb('files').$type<ChangedFile[]>().notNull().default([]),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    patch: text('patch'),
    patchTruncated: boolean('patch_truncated').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('story_commits_story_sha_uq').on(t.storyId, t.sha),
    index('story_commits_story_idx').on(t.storyId, t.committedAt),
  ],
)

/**
 * Tasks under a story — like GitHub issues or Azure Boards Tasks under a user story. Each can be started on its own
 * and runs through the project's workflow on its story's branch. `external` links the issue or work item it mirrors.
 */
export const storyTasks = pgTable(
  'story_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    /** Per story: T1, T2, … */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: taskStatus('status').notNull().default('todo'),
    assigneeId: uuid('assignee_id').references(() => users.id),
    rank: doublePrecision('rank').notNull().default(0),
    external: jsonb('external').$type<TaskExternalLink | null>(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    version: integer('version').notNull().default(1),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('story_tasks_story_number_uq').on(t.storyId, t.number), index('story_tasks_project_idx').on(t.projectId)],
)

/**
 * Agent workflow runs. Today runs execute in the developer's VS Code (`origin = extension`) and the extension
 * reports each state change here; Phase 2 adds runs the backend drives itself (`origin = server`).
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    storyId: uuid('story_id').references(() => stories.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id),
    origin: runOrigin('origin').notNull().default('extension'),
    /** Who executes the graph: the extension (reports snapshots) or the orchestrator service (drives each step). */
    driver: runDriver('driver').notNull().default('extension'),
    /** The workflow spec the run started with (orchestrator runs recompile their graph from it after a restart). */
    specSnapshot: jsonb('spec_snapshot').$type<WorkflowSpec | null>(),
    /** The run id in the client that executed it (the extension's local run id). */
    clientRunId: text('client_run_id').notNull(),
    workflowName: text('workflow_name').notNull(),
    status: runStatus('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    pendingApproval: jsonb('pending_approval').$type<{ stepId: string; question: string; kind?: 'plan' | 'approval'; context?: string; agentName?: string } | null>(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    changedFiles: text('changed_files').array().notNull().default(sql`'{}'::text[]`),
    /** The task under the story the run works on. */
    taskId: uuid('task_id').references(() => storyTasks.id, { onDelete: 'set null' }),
    workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    workflowVersion: integer('workflow_version'),
    /** The harness it ran in (`copilot`, `claude-code`, …); null for the built-in runtime. */
    engine: text('engine'),
    engineModel: text('engine_model'),
    engineSessionId: text('engine_session_id'),
    /** A quick fix started from a prompt (no story), or extra instructions given with the story. */
    prompt: text('prompt'),
    /** Who started it from the web, and when (origin `web`). */
    requestedBy: uuid('requested_by').references(() => users.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    /** When a VS Code window picked it up, and which one. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    clientId: text('client_id'),
    /** When the gateway confirmed it captured the ended run (memory, profile); the orchestrator retries until set. */
    finishNotifiedAt: timestamp('finish_notified_at', { withTimezone: true }),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('runs_user_client_run_uq').on(t.userId, t.clientRunId),
    index('runs_story_idx').on(t.storyId, t.startedAt),
    index('runs_project_status_idx').on(t.projectId, t.status),
    index('runs_task_idx').on(t.taskId),
  ],
)

export const runSteps = pgTable(
  'run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    seq: integer('seq').notNull(),
    nodeId: text('node_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    status: runStepStatus('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    gatePass: boolean('gate_pass'),
    gateReason: text('gate_reason'),
    approval: jsonb('approval').$type<ApprovalRecord | null>(),
    output: text('output'),
    plan: text('plan'),
    error: text('error'),
    changedFiles: text('changed_files').array().notNull().default(sql`'{}'::text[]`),
    /** Evaluator scores behind a gate step's verdict. Kept for older readers; `run_evaluations` has the detail. */
    evaluations: jsonb('evaluations').$type<EvaluationResult[]>().notNull().default([]),
    reportUrl: text('report_url'),
    /** The catalog agent bound to the step, and the skills bound to it and actually used. */
    agentSlug: text('agent_slug'),
    agentName: text('agent_name'),
    skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
    skillsUsed: jsonb('skills_used').$type<SkillUse[]>().notNull().default([]),
    model: text('model'),
    toolCalls: integer('tool_calls'),
    /** The harness the step ran in (orchestrator runs can use a different harness per step). */
    engine: text('engine'),
  },
  (t) => [uniqueIndex('run_steps_run_step_uq').on(t.runId, t.stepId)],
)

/**
 * Agent steps the orchestrator hands to a harness: one row per (step, phase). The harness picks it up through
 * `sdlc_next_step`, and its plan or result resumes the run's graph at `interrupt_id`. Written only by the
 * orchestrator service; LangGraph's own checkpoint tables live in the `orchestrator` schema.
 */
export const stepAssignments = pgTable(
  'step_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    nodeId: text('node_id').notNull(),
    phase: stepPhase('phase').notNull(),
    harness: text('harness').notNull(),
    /** The StepAssignment handed to the harness. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** The LangGraph interrupt the result resumes. */
    interruptId: text('interrupt_id'),
    status: stepAssignmentStatus('status').notNull().default('pending'),
    /** The submitted plan or completion. */
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('step_assignments_run_step_phase_uq').on(t.runId, t.stepId, t.phase),
    index('step_assignments_run_status_idx').on(t.runId, t.status),
  ],
)

/**
 * The event log of a run in a harness: steps, agents, skills, tool calls, files, plans and approvals. Reported in
 * batches by the extension, idempotent on (run, seq). Tool inputs are never stored raw.
 */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    type: text('type').notNull(),
    stepId: text('step_id'),
    agentType: text('agent_type'),
    agentName: text('agent_name'),
    skill: text('skill'),
    tool: text('tool'),
    path: text('path'),
    summary: text('summary'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [uniqueIndex('run_events_run_seq_uq').on(t.runId, t.seq)],
)

/** Every evaluator's verdict on every gate of a run, with its reason, dataset counts and judge usage. */
export const runEvaluations = pgTable(
  'run_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    nodeId: text('node_id'),
    stepLabel: text('step_label'),
    evaluator: text('evaluator').notNull(),
    score: doublePrecision('score'),
    threshold: doublePrecision('threshold'),
    pass: boolean('pass').notNull(),
    required: boolean('required'),
    reason: text('reason'),
    passedCount: integer('passed_count'),
    failedCount: integer('failed_count'),
    erroredCount: integer('errored_count'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    source: text('source'),
    evalId: text('eval_id'),
    evalRunId: text('eval_run_id'),
    reportUrl: text('report_url'),
    details: jsonb('details').$type<Record<string, unknown> | null>(),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('run_evaluations_run_step_evaluator_uq').on(t.runId, t.stepId, t.evaluator)],
)

/**
 * What a run changed, against the commit it started from (committed and uncommitted work, plus untracked files),
 * as VS Code last reported it. Replaced on every report; the patch is fetched separately.
 */
export const runChanges = pgTable('run_changes', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  branch: text('branch'),
  baseSha: text('base_sha'),
  headSha: text('head_sha'),
  files: jsonb('files').$type<ChangedFile[]>().notNull().default([]),
  additions: integer('additions').notNull().default(0),
  deletions: integer('deletions').notNull().default(0),
  patch: text('patch'),
  patchTruncated: boolean('patch_truncated').notNull().default(false),
  commits: jsonb('commits').$type<RunCommit[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The full before/after text of each text file a run changed, as VS Code last reported it (replaced on every report).
 * The run's branch lives only in the user's VS Code — it is never pushed — so this is how the Code page shows it as
 * a branch: the base tree with these files changed, and a side-by-side diff per file. `null` = no file on that side.
 */
export const runChangeContents = pgTable(
  'run_change_contents',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    oldPath: text('old_path'),
    original: text('original'),
    modified: text('modified'),
    /** Too large (or past the report's budget): no text was sent; the patch still shows the change. */
    truncated: boolean('truncated').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.runId, t.path] })],
)

/** The memory items a run was given: in its context files at the start (`context`), or when an agent asked (`tool`). */
export const runMemoryReads = pgTable(
  'run_memory_reads',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    memoryItemId: uuid('memory_item_id')
      .notNull()
      .references(() => memoryItems.id, { onDelete: 'cascade' }),
    stepId: text('step_id'),
    via: text('via').$type<RunMemoryVia>().notNull().default('context'),
    /** Whether people found the item helpful for this run (null: not rated). */
    helpful: boolean('helpful'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.memoryItemId] }), index('run_memory_reads_item_idx').on(t.memoryItemId)],
)

/** People's thumbs up / down (and comment) on a run: one per person per run. */
export const runFeedback = pgTable(
  'run_feedback',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.userId] })],
)

/** The AI summary of a run's impact (and, for a failed run, why it failed). Regenerated when its input changes. */
export const runInsights = pgTable('run_insights', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  impactMd: text('impact_md'),
  failureMd: text('failure_md'),
  model: text('model'),
  inputHash: text('input_hash').notNull(),
  generatedBy: uuid('generated_by').references(() => users.id, { onDelete: 'set null' }),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ─── Agent engines: user preferences and connected VS Code clients ──────────────────────────────

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** copilot | claude-code | codex; null = use the project default. */
  agentEngine: text('agent_engine'),
  engineModel: text('engine_model'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** One row per VS Code window (client id generated by the extension), refreshed by its heartbeat. */
export const clientPresence = pgTable(
  'client_presence',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    kind: text('kind').notNull(),
    version: text('version').notNull(),
    engines: jsonb('engines').$type<InstalledEngine[]>().notNull().default([]),
    workspace: jsonb('workspace').$type<{ remoteUrl: string | null; branch: string | null } | null>(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.clientId] })],
)

// ─── Linked repositories: the project's code, cloned into the database ────────────────────────────

/**
 * One GitHub / Azure Repos repository per project. The access token is stored encrypted (AES-256-GCM, key from
 * REPO_CREDENTIAL_KEY) and is never returned by the API.
 */
export const projectRepositories = pgTable('project_repositories', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  provider: repoProvider('provider').notNull(),
  /** HTTPS clone URL, without credentials. */
  remoteUrl: text('remote_url').notNull(),
  webUrl: text('web_url'),
  displayName: text('display_name').notNull(),
  /** Branch treated as default (agent/skill import, first index); follows the remote's HEAD unless pinned. */
  defaultBranch: text('default_branch'),
  /** True when an owner picked the default branch; false when it follows the remote's HEAD. */
  defaultBranchPinned: boolean('default_branch_pinned').notNull().default(false),
  credentialEnc: text('credential_enc'),
  credentialHint: text('credential_hint'),
  /** The Git connection the repository was imported (or published) with; null = match a connection by owner. */
  connectionId: uuid('connection_id').references((): AnyPgColumn => gitConnections.id, { onDelete: 'set null' }),
  status: repoStatus('status').notNull().default('queued'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  ...timestamps,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Every branch on the remote (from ls-remote). Files are held only for branches someone opened (`indexedSha`). */
export const repoBranches = pgTable(
  'repo_branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => projectRepositories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    remoteSha: text('remote_sha').notNull(),
    indexedSha: text('indexed_sha'),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    isDefault: boolean('is_default').notNull().default(false),
    commitMessage: text('commit_message'),
    commitAuthor: text('commit_author'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    fileCount: integer('file_count').notNull().default(0),
    ignoredCount: integer('ignored_count').notNull().default(0),
  },
  (t) => [uniqueIndex('repo_branches_repo_name_uq').on(t.repositoryId, t.name)],
)

/** Text contents of stored files, keyed by git blob sha — shared by every branch and sync that has the file. */
export const repoBlobs = pgTable(
  'repo_blobs',
  {
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => projectRepositories.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    size: integer('size').notNull(),
    content: text('content').notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.sha] })],
)

/**
 * The tree of one indexed branch: a row per file AND per folder, so a folder listing is `WHERE dir = $1`.
 * Files ignored by .gitignore have no row. Only `stored` files have their contents in repo_blobs.
 */
export const repoFiles = pgTable(
  'repo_files',
  {
    branchId: uuid('branch_id')
      .notNull()
      .references(() => repoBranches.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** Parent folder path; '' for the root. */
    dir: text('dir').notNull(),
    name: text('name').notNull(),
    type: repoEntryType('type').notNull(),
    /** Git mode (100644, 100755, 120000, 160000); 040000 for folders. */
    mode: text('mode').notNull(),
    /** Git object id; null for folders. */
    blobSha: text('blob_sha'),
    size: integer('size').notNull().default(0),
    /** Null for folders. */
    status: repoFileStatus('status'),
  },
  (t) => [primaryKey({ columns: [t.branchId, t.path] }), index('repo_files_branch_dir_idx').on(t.branchId, t.dir)],
)

/** A member's edit of one file on one branch, kept until they commit or discard it. Visible only to its author. */
export const repoFileDrafts = pgTable(
  'repo_file_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => projectRepositories.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull(),
    path: text('path').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The blob the edit started from — a commit is refused while the branch's file is a different blob. */
    baseBlobSha: text('base_blob_sha').notNull(),
    content: text('content').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('repo_file_drafts_uq').on(t.repositoryId, t.branch, t.path, t.userId)],
)

/** Sync jobs (clone, re-sync, index a branch): the job queue's state and the sync history. */
export const repoSyncs = pgTable(
  'repo_syncs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => projectRepositories.id, { onDelete: 'cascade' }),
    trigger: repoSyncTrigger('trigger').notNull(),
    /** The one branch this job is for; null for a full sync. */
    branch: text('branch'),
    status: repoSyncStatus('status').notNull().default('queued'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    stats: jsonb('stats').$type<RepoSyncStats>(),
    error: text('error'),
    ...timestamps,
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('repo_syncs_repo_created_idx').on(t.repositoryId, t.createdAt)],
)

/**
 * The organisation's Git access tokens, set up once by an org admin. A repository uses the connection for its
 * GitHub owner / Azure DevOps organization, else (GitHub) the one covering every owner. Tokens are encrypted
 * (REPO_CREDENTIAL_KEY) and never returned.
 */
export const gitConnections = pgTable(
  'git_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: repoProvider('provider').notNull(),
    /** GitHub owner or Azure DevOps organization as entered; null = every GitHub owner. */
    owner: text('owner'),
    name: text('name').notNull(),
    credentialEnc: text('credential_enc').notNull(),
    credentialHint: text('credential_hint').notNull(),
    /** The account the provider reported for the token when it was verified. */
    account: text('account'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Several connections may share a provider and owner (e.g. one token per person): a repository uses the one it
  // was imported with, else the most recently verified one for its owner (see pickConnection).
  (t) => [index('git_connections_scope_idx').on(t.orgId, t.provider, sql`lower(coalesce(${t.owner}, ''))`)],
)
