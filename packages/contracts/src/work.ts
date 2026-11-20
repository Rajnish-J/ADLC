// Code activity on a story, reported by the VS Code extension: each developer's live working state (uncommitted
// changes), the commits on the story branch, and the agent workflow runs started on the story. The backend
// records it; the web app and the extension both show it. Patches (diff text) are stored but fetched separately.

import { z } from 'zod'
import { UserSchema } from './schemas'

/** Largest patch stored for one commit or one working-state snapshot; bigger ones are cut and flagged. */
export const MAX_PATCH_CHARS = 256_000
/** Largest agent output / plan kept per run step. */
export const MAX_STEP_OUTPUT_CHARS = 8_000
export const MAX_STEP_PLAN_CHARS = 4_000

export const FILE_CHANGE_STATUSES = ['added', 'modified', 'deleted', 'renamed', 'copied', 'untracked', 'type_changed', 'unknown'] as const
export type FileChangeStatus = (typeof FILE_CHANGE_STATUSES)[number]

export const ChangedFileSchema = z.object({
  path: z.string().min(1).max(1000),
  /** The previous path of a renamed or copied file. */
  oldPath: z.string().max(1000).optional(),
  status: z.enum(FILE_CHANGE_STATUSES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean().default(false),
  /** True when the file matched the extension's diff-exclude patterns (secrets): its patch was never sent. */
  excluded: z.boolean().default(false),
})
export type ChangedFile = z.infer<typeof ChangedFileSchema>

const PatchFields = {
  patch: z.string().max(MAX_PATCH_CHARS + 1_000).nullable().default(null),
  patchTruncated: z.boolean().default(false),
}

// ─── Live working state ──────────────────────────────────────────────────────────────────────────

export const ReportWorkspaceInputSchema = z.object({
  branch: z.string().min(1).max(250),
  headSha: z.string().max(64).nullable(),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  files: z.array(ChangedFileSchema).max(1000),
  ...PatchFields,
})
export type ReportWorkspaceInput = z.input<typeof ReportWorkspaceInputSchema>

export const WorkspaceSnapshotSchema = z.object({
  user: UserSchema,
  branch: z.string(),
  headSha: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  files: z.array(ChangedFileSchema),
  additions: z.number().int(),
  deletions: z.number().int(),
  hasPatch: z.boolean(),
  patchTruncated: z.boolean(),
  updatedAt: z.string(),
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>

// ─── Commits ─────────────────────────────────────────────────────────────────────────────────────

export const ReportedCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  branch: z.string().min(1).max(250),
  message: z.string().max(5_000),
  authorName: z.string().max(200),
  authorEmail: z.string().max(320),
  committedAt: z.string().datetime({ offset: true }),
  files: z.array(ChangedFileSchema).max(2000),
  ...PatchFields,
})
export type ReportedCommit = z.input<typeof ReportedCommitSchema>

export const ReportCommitsInputSchema = z.object({
  commits: z.array(ReportedCommitSchema).min(1).max(20),
})
export type ReportCommitsInput = z.input<typeof ReportCommitsInputSchema>

export const StoryCommitSchema = z.object({
  sha: z.string(),
  branch: z.string(),
  message: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  /** The platform user whose VS Code reported the commit. */
  reportedBy: UserSchema.nullable(),
  committedAt: z.string(),
  files: z.array(ChangedFileSchema),
  additions: z.number().int(),
  deletions: z.number().int(),
  hasPatch: z.boolean(),
  patchTruncated: z.boolean(),
})
export type StoryCommit = z.infer<typeof StoryCommitSchema>

// ─── Agent runs ──────────────────────────────────────────────────────────────────────────────────

/**
 * `requested`: started from the web, waiting for the user's VS Code to pick it up. `expired`: no VS Code window
 * picked it up in time. The rest are reported by the extension as the run progresses.
 */
export const RUN_STATUSES = ['requested', 'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired'] as const
export type StoryRunStatus = (typeof RUN_STATUSES)[number]

/** Statuses the extension reports (a run only becomes requested or expired on the server). */
export const REPORTED_RUN_STATUSES = ['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'] as const

export const RUN_ORIGINS = ['extension', 'server', 'web'] as const
export type RunOrigin = (typeof RUN_ORIGINS)[number]

/**
 * Who executes the run's workflow graph: `extension` — the VS Code extension runs it locally and reports
 * snapshots; `orchestrator` — the platform's orchestrator service drives it step by step and hands each agent
 * step to a harness in the user's VS Code.
 */
export const RUN_DRIVERS = ['extension', 'orchestrator'] as const
export type RunDriver = (typeof RUN_DRIVERS)[number]

/** How long a run requested from the web waits for a VS Code window to claim it. */
export const RUN_REQUEST_TTL_MS = 2 * 60_000

export const RUN_STATUS_LABELS: Record<StoryRunStatus, string> = {
  requested: 'Requested',
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

export const RUN_STEP_STATUSES = ['running', 'succeeded', 'failed', 'skipped', 'blocked'] as const
export type StoryRunStepStatus = (typeof RUN_STEP_STATUSES)[number]

export const ApprovalRecordSchema = z.object({
  approve: z.boolean(),
  comment: z.string().max(2_000).optional(),
  actor: z.string().max(320).optional(),
})
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>

/** One evaluator's verdict on a gate step: its score against the threshold the gate policy set. */
export const EvaluationResultSchema = z.object({
  evaluator: z.string().min(1).max(200),
  score: z.number().nullable(),
  threshold: z.number().nullable(),
  pass: z.boolean(),
  /** False when the evaluator is advisory: its failure does not fail the gate. */
  required: z.boolean().nullable().optional(),
  /** Why the evaluator passed or failed, in its own words. */
  reason: z.string().max(2_000).nullable().optional(),
  /** Rows of the evaluation dataset that passed, failed or errored. */
  counts: z
    .object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), errored: z.number().int().nonnegative() })
    .nullable()
    .optional(),
  /** Tokens the judge model used for this evaluator, when known. */
  tokensIn: z.number().int().nonnegative().nullable().optional(),
  tokensOut: z.number().int().nonnegative().nullable().optional(),
  /** Where the score came from: Azure AI Foundry, or the local stub when Foundry is not configured. */
  source: z.enum(['foundry', 'stub', 'auto']).nullable().optional(),
  evalId: z.string().max(200).nullable().optional(),
  evalRunId: z.string().max(200).nullable().optional(),
  /** Small extra detail from the evaluator (no raw dataset rows). */
  details: z.record(z.unknown()).nullable().optional(),
})
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>

/** A skill a step used: `observed` in the harness's activity, or `declared` by the agent when it finished. */
export const SkillUseSchema = z.object({ slug: z.string().max(200), evidence: z.enum(['observed', 'declared']) })
export type SkillUse = z.infer<typeof SkillUseSchema>

export const RunStepReportSchema = z.object({
  stepId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  nodeId: z.string().max(200),
  kind: z.string().max(40),
  label: z.string().max(300),
  status: z.enum(RUN_STEP_STATUSES),
  startedAt: z.string().datetime({ offset: true }).nullable().default(null),
  finishedAt: z.string().datetime({ offset: true }).nullable().default(null),
  tokensIn: z.number().int().nonnegative().nullable().default(null),
  tokensOut: z.number().int().nonnegative().nullable().default(null),
  gatePass: z.boolean().nullable().default(null),
  gateReason: z.string().max(2_000).nullable().default(null),
  approval: ApprovalRecordSchema.nullable().default(null),
  output: z.string().max(MAX_STEP_OUTPUT_CHARS + 100).nullable().default(null),
  plan: z.string().max(MAX_STEP_PLAN_CHARS + 100).nullable().default(null),
  error: z.string().max(4_000).nullable().default(null),
  changedFiles: z.array(z.string().max(1000)).max(500).default([]),
  /** Evaluator scores behind a gate step's verdict (empty for other steps). */
  evaluations: z.array(EvaluationResultSchema).max(50).default([]),
  /** Link to the full evaluation report (e.g. the Foundry run), when there is one. */
  reportUrl: z.string().max(2_000).nullable().default(null),
  /** The catalog agent bound to this step (agent steps only). */
  agentSlug: z.string().max(200).nullable().default(null),
  agentName: z.string().max(200).nullable().default(null),
  /** Skills bound to this step in the workflow. */
  skills: z.array(z.string().max(200)).max(50).default([]),
  /** Skills the run actually used in this step, and how that is known. */
  skillsUsed: z.array(SkillUseSchema).max(50).default([]),
  /** The model that did the work, when the harness reports it. */
  model: z.string().max(120).nullable().default(null),
  toolCalls: z.number().int().nonnegative().nullable().default(null),
  /** The harness this step ran in, when it differs per step (platform-driven runs). */
  engine: z.string().max(40).nullable().default(null),
})
export type RunStepReport = z.input<typeof RunStepReportSchema>

export const ReportRunInputSchema = z.object({
  workflowName: z.string().min(1).max(200),
  status: z.enum(REPORTED_RUN_STATUSES),
  /** The harness the run executed in (`copilot`, `claude-code`, …); null for the built-in runtime. */
  engine: z.string().max(40).nullable().default(null),
  engineModel: z.string().max(120).nullable().default(null),
  /** The harness's own session id, to correlate its logs. */
  engineSessionId: z.string().max(200).nullable().default(null),
  workflowId: z.string().uuid().nullable().default(null),
  workflowVersion: z.number().int().nullable().default(null),
  /** The task (under the story) the run works on. */
  taskNumber: z.number().int().positive().nullable().default(null),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable().default(null),
  error: z.string().max(4_000).nullable().default(null),
  /** The question a run paused on, while it awaits a human decision. */
  pendingApproval: z.object({ stepId: z.string().max(200), question: z.string().max(2_000) }).nullable().default(null),
  steps: z.array(RunStepReportSchema).max(200),
})
export type ReportRunInput = z.input<typeof ReportRunInputSchema>

export const StoryRunStepSchema = RunStepReportSchema.extend({
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  gatePass: z.boolean().nullable(),
  gateReason: z.string().nullable(),
  approval: ApprovalRecordSchema.nullable(),
  output: z.string().nullable(),
  plan: z.string().nullable(),
  error: z.string().nullable(),
  changedFiles: z.array(z.string()),
  evaluations: z.array(EvaluationResultSchema),
  reportUrl: z.string().nullable(),
  agentSlug: z.string().nullable(),
  agentName: z.string().nullable(),
  skills: z.array(z.string()),
  skillsUsed: z.array(SkillUseSchema),
  model: z.string().nullable(),
  toolCalls: z.number().int().nullable(),
  engine: z.string().nullable().default(null),
})
export type StoryRunStep = z.infer<typeof StoryRunStepSchema>

export const RunTaskRefSchema = z.object({ number: z.number().int(), key: z.string(), title: z.string() })
export type RunTaskRef = z.infer<typeof RunTaskRefSchema>

export const PendingApprovalSchema = z.object({
  stepId: z.string(),
  question: z.string(),
  kind: z.enum(['plan', 'approval']).optional(),
  context: z.string().optional(),
  agentName: z.string().optional(),
})
export type PendingApproval = z.infer<typeof PendingApprovalSchema>

export const StoryRunSchema = z.object({
  id: z.string().uuid(),
  clientRunId: z.string(),
  origin: z.enum(RUN_ORIGINS),
  driver: z.enum(RUN_DRIVERS).default('extension'),
  workflowName: z.string(),
  workflowId: z.string().nullable(),
  workflowVersion: z.number().int().nullable(),
  /** The harness it ran in; null for the built-in runtime. */
  engine: z.string().nullable(),
  engineModel: z.string().nullable(),
  task: RunTaskRefSchema.nullable(),
  /** The quick fix it was started with (no story), or extra instructions given with the story. */
  prompt: z.string().nullable().default(null),
  /** Who started it from the web (null when started in VS Code). */
  requestedBy: UserSchema.nullable(),
  requestedAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
  /** The VS Code window that picked the run up. */
  clientId: z.string().nullable(),
  status: z.enum(RUN_STATUSES),
  startedBy: UserSchema.nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  /**
   * The question a run is paused on. `kind` says whether it is an agent's plan or an approval node; `context` is what
   * is being approved (the plan, or the latest agent's output) and `agentName` who produced it.
   */
  pendingApproval: PendingApprovalSchema.nullable(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  changedFiles: z.array(z.string()),
  steps: z.array(StoryRunStepSchema),
})
export type StoryRun = z.infer<typeof StoryRunSchema>

/** What a run worked on: a story, a task under a story, or a quick fix (a prompt with no story). */
export const RUN_KINDS = ['story', 'task', 'quick'] as const
export type RunKind = (typeof RUN_KINDS)[number]

export const RUN_KIND_LABELS: Record<RunKind, string> = { story: 'Story', task: 'Task', quick: 'Quick fix' }

/** A run in the project-wide run list: the story it ran on, plus gate tallies for the table. */
export const ProjectRunSchema = StoryRunSchema.omit({ steps: true }).extend({
  story: z.object({ key: z.string(), number: z.number().int(), title: z.string() }).nullable(),
  stepCount: z.number().int(),
  gatesPassed: z.number().int(),
  gatesFailed: z.number().int(),
  /** Distinct agents and skills that ran (from the steps). */
  agentsUsed: z.array(z.string()),
  skillsUsed: z.array(z.string()),
  kind: z.enum(RUN_KINDS).default('story'),
  /** Which attempt this is at its story or task (1 = the first run); null for a quick fix. */
  iteration: z.number().int().nullable().default(null),
  /** The branch the run worked on, once VS Code reported its changes. */
  branch: z.string().nullable().default(null),
  /** Size of what the run changed, against the commit it started from. */
  filesChanged: z.number().int().default(0),
  additions: z.number().int().default(0),
  deletions: z.number().int().default(0),
  /** Memory items the agent was given or read, and items the run wrote. */
  memoryUsed: z.number().int().default(0),
  memoryWritten: z.number().int().default(0),
  /** People's thumbs up / down on the run. */
  feedback: z.object({ up: z.number().int(), down: z.number().int() }).default({ up: 0, down: 0 }),
})
export type ProjectRun = z.infer<typeof ProjectRunSchema>

export const RunListQuerySchema = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  workflow: z.string().max(200).optional(),
  engine: z.string().max(40).optional(),
  story: z.coerce.number().int().positive().optional(),
  task: z.coerce.number().int().positive().optional(),
  kind: z.enum(RUN_KINDS).optional(),
  /** Who started the run. */
  user: z.string().uuid().optional(),
  /** Runs that changed a file whose path contains this text. */
  file: z.string().trim().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export type RunListQuery = z.input<typeof RunListQuerySchema>

// ─── Everything on one story ─────────────────────────────────────────────────────────────────────

export const StoryWorkSchema = z.object({
  workspaces: z.array(WorkspaceSnapshotSchema),
  commits: z.array(StoryCommitSchema),
  runs: z.array(StoryRunSchema),
})
export type StoryWork = z.infer<typeof StoryWorkSchema>

export const PatchSchema = z.object({
  patch: z.string().nullable(),
  patchTruncated: z.boolean(),
})
export type Patch = z.infer<typeof PatchSchema>
