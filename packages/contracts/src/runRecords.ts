// The full record of one agent run: what it changed (against the commit it started from), the memory it was
// given and wrote, the context it worked from, which attempt it was at its story or task, people's feedback and
// an AI summary of its impact. VS Code reports the changes; the platform records memory use itself.

import { z } from 'zod'
import { UserSchema } from './schemas'
import { MEMORY_KINDS, MEMORY_SCOPES, MEMORY_SOURCES, MEMORY_STATUSES } from './memory'
import { ChangedFileSchema, MAX_PATCH_CHARS, ProjectRunSchema, StoryRunStepSchema } from './work'

// ─── What a run changed ──────────────────────────────────────────────────────────────────────────

export const RunCommitSchema = z.object({
  sha: z.string().min(4).max(64),
  message: z.string().max(2_000),
  committedAt: z.string().nullable().default(null),
  /** How many files the commit touched. */
  files: z.number().int().nonnegative().default(0),
})
export type RunCommit = z.infer<typeof RunCommitSchema>

/** Largest file whose full before/after text a run report carries (for the Code page's side-by-side diff). */
export const MAX_RUN_FILE_CHARS = 256_000
/** Largest total of before/after text one run report carries. */
export const MAX_RUN_CONTENT_CHARS = 4_000_000

/**
 * One changed file's full text before the run (at its start commit) and now (the working tree), so the Code page
 * can show the run's branch — which lives only in the user's VS Code — as a real diff. `null` = the file does not
 * exist on that side (added / deleted). `truncated`: the file was too large (or the report's budget ran out), so
 * its text was left out and only the patch shows it.
 */
export const RunFileContentSchema = z.object({
  path: z.string().min(1).max(1000),
  oldPath: z.string().max(1000).optional(),
  original: z.string().max(MAX_RUN_FILE_CHARS).nullable(),
  modified: z.string().max(MAX_RUN_FILE_CHARS).nullable(),
  truncated: z.boolean().default(false),
})
export type RunFileContent = z.infer<typeof RunFileContentSchema>

/** The run's changes against the commit it started from: committed and uncommitted, plus untracked files. */
export const ReportRunChangesInputSchema = z.object({
  branch: z.string().max(250).nullable().default(null),
  baseSha: z.string().max(64).nullable().default(null),
  headSha: z.string().max(64).nullable().default(null),
  files: z.array(ChangedFileSchema).max(2_000),
  patch: z.string().max(MAX_PATCH_CHARS + 1_000).nullable().default(null),
  patchTruncated: z.boolean().default(false),
  commits: z.array(RunCommitSchema).max(100).default([]),
  /** Full before/after text of the changed text files (only when diffs are shared); omitted by older extensions. */
  contents: z.array(RunFileContentSchema).max(2_000).optional(),
})
export type ReportRunChangesInput = z.input<typeof ReportRunChangesInputSchema>

export const RunChangesSchema = z.object({
  branch: z.string().nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  files: z.array(ChangedFileSchema),
  additions: z.number().int(),
  deletions: z.number().int(),
  hasPatch: z.boolean(),
  patchTruncated: z.boolean(),
  commits: z.array(RunCommitSchema),
  updatedAt: z.string(),
})
export type RunChanges = z.infer<typeof RunChangesSchema>

// ─── Memory the run used and wrote ───────────────────────────────────────────────────────────────

export const RUN_MEMORY_VIA = ['context', 'tool'] as const
export type RunMemoryVia = (typeof RUN_MEMORY_VIA)[number]

export const RunMemoryRefSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(MEMORY_SCOPES),
  kind: z.enum(MEMORY_KINDS),
  status: z.enum(MEMORY_STATUSES),
  title: z.string(),
  content: z.string(),
  pinned: z.boolean(),
  storyKey: z.string().nullable(),
  storyNumber: z.number().int().nullable(),
  createdAt: z.string(),
})
export type RunMemoryRef = z.infer<typeof RunMemoryRefSchema>

/** An item the run was given: in its context files at the start, or when an agent asked for memory. */
export const RunMemoryUsedSchema = RunMemoryRefSchema.extend({
  via: z.enum(RUN_MEMORY_VIA),
  stepId: z.string().nullable(),
  /** Whether people found the item helpful for this run (null: not rated). */
  helpful: z.boolean().nullable(),
  at: z.string(),
})
export type RunMemoryUsed = z.infer<typeof RunMemoryUsedSchema>

/** An item the run wrote (an agent's note, or a summary / learning captured when it ended). */
export const RunMemoryWrittenSchema = RunMemoryRefSchema.extend({
  source: z.enum(MEMORY_SOURCES),
  /** How many later runs were given this item. */
  usedByRuns: z.number().int(),
})
export type RunMemoryWritten = z.infer<typeof RunMemoryWrittenSchema>

export const RunMemorySchema = z.object({
  used: z.array(RunMemoryUsedSchema),
  written: z.array(RunMemoryWrittenSchema),
  /** Distinct later runs given anything this run wrote. */
  usedLater: z.number().int(),
})
export type RunMemory = z.infer<typeof RunMemorySchema>

export const RunMemoryHelpfulInputSchema = z.object({ helpful: z.boolean().nullable() })
export type RunMemoryHelpfulInput = z.infer<typeof RunMemoryHelpfulInputSchema>

// ─── What the agent worked from ──────────────────────────────────────────────────────────────────

export const RunStepContextSchema = z.object({
  nodeId: z.string(),
  label: z.string(),
  agentSlug: z.string().nullable(),
  agentName: z.string().nullable(),
  skills: z.array(z.string()),
  /** The harness the step ran in (its own, or the run's). */
  harness: z.string().nullable(),
})
export type RunStepContext = z.infer<typeof RunStepContextSchema>

export const RunContextSchema = z.object({
  prompt: z.string().nullable(),
  story: z.object({ key: z.string(), number: z.number().int(), title: z.string(), description: z.string() }).nullable(),
  task: z.object({ key: z.string(), number: z.number().int(), title: z.string(), description: z.string() }).nullable(),
  steps: z.array(RunStepContextSchema),
})
export type RunContext = z.infer<typeof RunContextSchema>

/** Which attempt a run is at its story or task, with the runs either side of it. */
export const RunIterationSchema = z.object({
  number: z.number().int(),
  total: z.number().int(),
  previousId: z.string().uuid().nullable(),
  nextId: z.string().uuid().nullable(),
})
export type RunIteration = z.infer<typeof RunIterationSchema>

// ─── People's feedback and the AI summary ────────────────────────────────────────────────────────

export const RunRatingSchema = z.union([z.literal(1), z.literal(-1)])
export type RunRating = z.infer<typeof RunRatingSchema>

export const RunFeedbackSchema = z.object({
  user: UserSchema,
  rating: RunRatingSchema,
  comment: z.string().nullable(),
  updatedAt: z.string(),
})
export type RunFeedback = z.infer<typeof RunFeedbackSchema>

/** A rating of null removes the caller's feedback. */
export const RunFeedbackInputSchema = z.object({
  rating: RunRatingSchema.nullable(),
  comment: z.string().trim().max(2_000).optional(),
})
export type RunFeedbackInput = z.infer<typeof RunFeedbackInputSchema>

export const RunInsightSchema = z.object({
  /** False when no model is configured; `reason` says why. */
  enabled: z.boolean(),
  reason: z.string().nullable(),
  impact: z.string().nullable(),
  /** For a failed or cancelled run: why it likely failed and what to try next. */
  failure: z.string().nullable(),
  model: z.string().nullable(),
  generatedAt: z.string().nullable(),
  /** True when the run changed since the summary was written (regenerate to refresh it). */
  stale: z.boolean(),
})
export type RunInsight = z.infer<typeof RunInsightSchema>

export const GenerateRunInsightInputSchema = z.object({ force: z.boolean().default(false) })
export type GenerateRunInsightInput = z.input<typeof GenerateRunInsightInputSchema>

// ─── One run, in full ────────────────────────────────────────────────────────────────────────────

/** One run with its step timeline, evaluations, changes, memory, context, attempt, feedback and insight. */
export const ProjectRunDetailSchema = ProjectRunSchema.extend({
  steps: z.array(StoryRunStepSchema),
  changes: RunChangesSchema.nullable().default(null),
  memory: RunMemorySchema.default({ used: [], written: [], usedLater: 0 }),
  context: RunContextSchema.nullable().default(null),
  /** Which attempt this is at its story or task, with the runs either side of it (null for a quick fix). */
  attempt: RunIterationSchema.nullable().default(null),
  /** Each person's thumbs up / down and comment (the list row's `feedback` has the tallies). */
  feedbackEntries: z.array(RunFeedbackSchema).default([]),
  insight: RunInsightSchema.nullable().default(null),
})
export type ProjectRunDetail = z.infer<typeof ProjectRunDetailSchema>

// ─── Across runs ─────────────────────────────────────────────────────────────────────────────────

export const RunStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  user: z.string().uuid().optional(),
})
export type RunStatsQuery = z.input<typeof RunStatsQuerySchema>

export const RunStatsSchema = z.object({
  days: z.number().int(),
  totals: z.object({
    runs: z.number().int(),
    completed: z.number().int(),
    failed: z.number().int(),
    cancelled: z.number().int(),
    active: z.number().int(),
    /** Completed out of completed + failed runs (cancelled ones don't count); null when none ended. */
    successRate: z.number().nullable(),
    medianDurationMs: z.number().nullable(),
    filesChanged: z.number().int(),
    additions: z.number().int(),
    deletions: z.number().int(),
  }),
  perDay: z.array(z.object({ date: z.string(), completed: z.number().int(), failed: z.number().int(), cancelled: z.number().int(), other: z.number().int() })),
  perUser: z.array(z.object({ user: UserSchema, runs: z.number().int(), completed: z.number().int(), failed: z.number().int() })),
  perHarness: z.array(
    z.object({ engine: z.string().nullable(), runs: z.number().int(), completed: z.number().int(), failed: z.number().int(), medianDurationMs: z.number().nullable() }),
  ),
  /** The files runs changed most often. */
  hotspots: z.array(z.object({ path: z.string(), runs: z.number().int() })),
})
export type RunStats = z.infer<typeof RunStatsSchema>
