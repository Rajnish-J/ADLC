// Harness sessions: starting a story or task from the web so it runs in the user's own VS Code. The web requests a
// run (status `requested`), the API tells that user's VS Code over SSE and the browser opens a vscode:// link; the
// first window to claim it starts the workflow in the chosen harness and reports it like any other run.

import { z } from 'zod'
import { WorkflowSpecInputSchema } from './catalog'
import { HarnessIdSchema } from './engines'
import { StoryTaskSchema } from './tasks'
import { RUN_DRIVERS, RUN_STATUSES, StoryRunSchema } from './work'

/** The VS Code extension that handles `vscode://` start links. */
export const EXTENSION_URI_AUTHORITY = 'synergech.sdlc-governance-extension'

/** The longest quick-fix prompt a run can be started with. */
export const RUN_PROMPT_MAX = 4000

/**
 * Start a story, one of its tasks, or — with no story — a quick fix described by `prompt`. With a story, `prompt` is
 * extra instructions for the run.
 */
export const RequestRunInputSchema = z
  .object({
    storyNumber: z.number().int().positive().nullable().optional(),
    taskNumber: z.number().int().positive().nullable().optional(),
    prompt: z.string().trim().max(RUN_PROMPT_MAX).nullable().optional(),
    workflowId: z.string().uuid(),
    engine: HarnessIdSchema,
    engineModel: z.string().trim().max(120).nullable().optional(),
    /** The VS Code window to start it in; omitted = any of the user's windows that has the harness. */
    clientId: z.string().regex(/^[\w-]{8,64}$/).nullable().optional(),
  })
  .refine((v) => v.storyNumber != null || !!v.prompt, { message: 'Pick a story or describe the fix', path: ['prompt'] })
  .refine((v) => v.taskNumber == null || v.storyNumber != null, { message: 'A task needs its story', path: ['taskNumber'] })
export type RequestRunInput = z.input<typeof RequestRunInputSchema>

export const RequestRunResultSchema = z.object({
  run: StoryRunSchema,
  /** Open this to hand the run to VS Code (it also gets a live event). */
  deepLink: z.string(),
  /** The VS Code window the run was sent to; null when any window may take it. */
  clientId: z.string().nullable().default(null),
  /**
   * `window`: sent to an online window that already has the project's repo open — its live connection delivers the
   * run, so don't open the link (it can land in, or open, another window). `link`: open `deepLink`.
   */
  delivery: z.enum(['window', 'link']).default('link'),
})
export type RequestRunResult = z.infer<typeof RequestRunResultSchema>

export const ClaimRunInputSchema = z.object({
  clientId: z.string().regex(/^[\w-]{8,64}$/),
})
export type ClaimRunInput = z.infer<typeof ClaimRunInputSchema>

/** Everything a VS Code window needs to start a claimed run. */
export const RunLaunchSchema = z.object({
  run: StoryRunSchema,
  projectKey: z.string(),
  /** The story it runs on; null for a quick fix started from a prompt. */
  storyNumber: z.number().int().nullable(),
  storyKey: z.string().nullable(),
  task: StoryTaskSchema.nullable(),
  /** The quick fix to make (no story), or extra instructions for the story. */
  prompt: z.string().nullable().default(null),
  workflowId: z.string(),
  workflowVersion: z.number().int(),
  engine: HarnessIdSchema,
  engineModel: z.string().nullable(),
  /**
   * `orchestrator`: the platform drives the workflow and hands each agent step to a harness — the window only hosts
   * the harnesses. `extension` (older servers): the window runs the workflow itself.
   */
  driver: z.enum(RUN_DRIVERS).default('extension'),
  /** The harness each agent step runs in (node id → harness), for orchestrator-driven runs. */
  stepHarnesses: z.record(HarnessIdSchema).default({}),
  /**
   * The workflow exactly as the run was started with it (the orchestrator's snapshot). VS Code prepares the agents,
   * skills and steps from it, so editing the workflow mid-run can't desync the window from the platform. Null from
   * older servers: then the window loads the workflow's current version.
   */
  workflowSpec: WorkflowSpecInputSchema.nullable().default(null),
})
export type RunLaunch = z.infer<typeof RunLaunchSchema>

export const RUN_COMMANDS = ['cancel'] as const
export type RunCommand = (typeof RUN_COMMANDS)[number]

/** A run cannot start because steps need harnesses that are not installed (409 `details`). */
export const MissingHarnessesSchema = z.object({
  missing: z.array(z.object({ engine: z.string(), label: z.string(), nodeIds: z.array(z.string()) })),
})
export type MissingHarnesses = z.infer<typeof MissingHarnessesSchema>

// ─── Agent steps handed to a harness (orchestrator-driven runs) ─────────────────────────────────

export const STEP_PHASES = ['plan', 'execute'] as const
export type StepPhase = (typeof STEP_PHASES)[number]

export const SkillRefSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /** Where the skill's instructions are in the workspace, for the harness to read. */
  path: z.string().optional(),
})
export type SkillRef = z.infer<typeof SkillRefSchema>

/** One agent step for a harness to work on: plan it, or (after approval) execute the approved plan. */
export const StepAssignmentSchema = z.object({
  action: z.enum(STEP_PHASES),
  stepId: z.string(),
  nodeId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  /** What to do now: the step's prompt (prior output / handoff) and, for execute, the approved plan. */
  instructions: z.string(),
  workItem: z.string().optional(),
  approvedPlan: z.string().optional(),
  skills: z.array(SkillRefSchema),
  /** The catalog agent's own instructions (its role), and where they were written in the workspace. */
  agentInstructions: z.string().optional(),
  agentFile: z.string().optional(),
  /** The harness this step runs in. */
  harness: z.string().optional(),
})
export type StepAssignment = z.infer<typeof StepAssignmentSchema>

/** What `sdlc_next_step` answers. `handoff`: the next step belongs to another harness — end your turn. */
export const NextStepSchema = z.union([
  StepAssignmentSchema,
  z.object({
    action: z.literal('waiting'),
    reason: z.enum(['approval', 'gate', 'idle']),
    retryAfterSec: z.number().int(),
    message: z.string(),
  }),
  z.object({ action: z.literal('handoff'), harness: z.string(), message: z.string() }),
  z.object({ action: z.enum(['done', 'stopped']), reason: z.string().optional() }),
])
export type NextStep = z.infer<typeof NextStepSchema>

export const NextStepQuerySchema = z.object({
  harness: HarnessIdSchema,
  clientId: z.string().regex(/^[\w-]{8,64}$/).optional(),
  /** Long-poll: wait up to this many seconds for work. */
  wait: z.coerce.number().int().min(0).max(50).default(25),
})
export type NextStepQuery = z.input<typeof NextStepQuerySchema>

export const SubmitPlanInputSchema = z.object({
  plan: z.string().min(1).max(60_000),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
})
export type SubmitPlanInput = z.infer<typeof SubmitPlanInputSchema>

export const CompleteStepInputSchema = z.object({
  summary: z.string().min(1).max(60_000),
  skillsUsed: z.array(z.string().max(200)).max(50).default([]),
  /** Run variables the step sets (e.g. `Local.TestsPassed`), for later conditions to branch on. */
  outputs: z.record(z.unknown()).optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  model: z.string().max(120).optional(),
  /** Workspace-relative paths this step changed (from git snapshots taken around the step). */
  changedFiles: z.array(z.string().max(1000)).max(500).optional(),
})
export type CompleteStepInput = z.input<typeof CompleteStepInputSchema>

export const StepAckSchema = z.object({ ok: z.literal(true), stepId: z.string() })
export type StepAck = z.infer<typeof StepAckSchema>

/** Cancelling a run; `reason` is kept as the run's error (e.g. VS Code could not start it, or the user declined it). */
export const CancelRunInputSchema = z.object({
  reason: z.string().trim().max(2_000).optional(),
})
export type CancelRunInput = z.infer<typeof CancelRunInputSchema>

/** A human decision on the step a run is waiting on (a plan approval or an approval step). */
export const ApproveRunInputSchema = z.object({
  approve: z.boolean(),
  comment: z.string().max(2_000).optional(),
  /** The step the decision is for; guards against approving a step the run has already moved past. */
  stepId: z.string().max(200).optional(),
})
export type ApproveRunInput = z.infer<typeof ApproveRunInputSchema>

export const ApproveRunResultSchema = z.object({ ok: z.literal(true), status: z.enum(RUN_STATUSES) })
export type ApproveRunResult = z.infer<typeof ApproveRunResultSchema>

// ─── Harness on a workflow step ───────────────────────────────────────────────────────────────────

/** Pin an agent step to a harness, or `null` to use the harness the run starts with. */
export const SetStepHarnessInputSchema = z.object({ harness: HarnessIdSchema.nullable() })
export type SetStepHarnessInput = z.infer<typeof SetStepHarnessInputSchema>

export const SetStepHarnessResultSchema = z.object({
  workflowId: z.string(),
  nodeId: z.string(),
  harness: z.string().nullable(),
  version: z.number().int(),
})
export type SetStepHarnessResult = z.infer<typeof SetStepHarnessResultSchema>

/** Runs of mine waiting for a VS Code window (a reconnecting extension catches up with these). */
export const PendingRunsSchema = z.array(
  z.object({ runId: z.string().uuid(), projectKey: z.string(), storyNumber: z.number().int().nullable(), clientId: z.string().nullable(), engine: z.string() }),
)
export type PendingRuns = z.infer<typeof PendingRunsSchema>

/** An agent step handed to a harness and not answered yet (`pending`: nobody took it; `delivered`: a harness did). */
export const WaitingStepSchema = z.object({
  stepId: z.string(),
  nodeId: z.string(),
  phase: z.enum(STEP_PHASES),
  harness: z.string(),
  status: z.enum(['pending', 'delivered']),
})
export type WaitingStep = z.infer<typeof WaitingStepSchema>

/** My runs that have not ended, newest first: the run monitor's list, and what a reloaded VS Code window resumes. */
export const ActiveRunSchema = z.object({
  runId: z.string().uuid(),
  projectKey: z.string(),
  storyNumber: z.number().int().nullable(),
  clientId: z.string().nullable(),
  engine: z.string(),
  status: z.enum(RUN_STATUSES),
  driver: z.enum(RUN_DRIVERS),
  workflowName: z.string(),
  workflowId: z.string().nullable(),
  prompt: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  waitingSteps: z.array(WaitingStepSchema),
})
export type ActiveRun = z.infer<typeof ActiveRunSchema>
export const ActiveRunsSchema = z.array(ActiveRunSchema)

/** `vscode://synergech.sdlc-governance-extension/start?run=…&project=…[&story=…]`. */
export function runDeepLink(runId: string, projectKey: string, storyNumber?: number | null): string {
  const q = `run=${encodeURIComponent(runId)}&project=${encodeURIComponent(projectKey)}${storyNumber != null ? `&story=${storyNumber}` : ''}`
  return `vscode://${EXTENSION_URI_AUTHORITY}/start?${q}`
}

/** `vscode://synergech.sdlc-governance-extension/open?run=…&project=…`: check out the run's branch to review it. */
export function runOpenLink(runId: string, projectKey: string): string {
  return `vscode://${EXTENSION_URI_AUTHORITY}/open?run=${encodeURIComponent(runId)}&project=${encodeURIComponent(projectKey)}`
}

// ─── Skills on a workflow step ───────────────────────────────────────────────────────────────────

/** The skills an agent step may use (replaces the list). Each must be an enabled skill the caller may use. */
export const SetStepSkillsInputSchema = z.object({
  skills: z.array(z.string().regex(/^[a-z0-9-]+$/).max(200)).max(20),
})
export type SetStepSkillsInput = z.infer<typeof SetStepSkillsInputSchema>

export const SetStepSkillsResultSchema = z.object({
  workflowId: z.string(),
  nodeId: z.string(),
  skills: z.array(z.object({ slug: z.string(), name: z.string() })),
  version: z.number().int(),
})
export type SetStepSkillsResult = z.infer<typeof SetStepSkillsResultSchema>
