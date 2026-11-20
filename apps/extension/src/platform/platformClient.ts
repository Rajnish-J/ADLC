// HTTP client for the SDLC platform API — the same backend the web app uses. Framework-free (no `vscode`) so it
// is unit-testable and could serve a CLI. Every response is validated with the shared @sdlc/contracts schemas.

import { z, type ZodType, type ZodTypeDef } from 'zod'
import { MySettingsSchema, type ClientPresenceInput, type MySettings } from '@sdlc/contracts'
// Harness runs: claiming a run started from the web, its activity log, and tasks under a story.
import {
  PendingRunsSchema,
  ActiveRunsSchema,
  RunEventsPageSchema,
  RequestRunResultSchema,
  RunLaunchSchema,
  StoryTaskSchema,
  type PendingRuns,
  type ActiveRun,
  type RunEventsPage,
  type RequestRunInput,
  type RequestRunResult,
  type ReportRunEventsInput,
  type RunLaunch,
  type StoryTask,
} from '@sdlc/contracts'
// Orchestrator-driven runs: agent steps handed to a harness, human decisions, and the harness pinned to a step.
import {
  ApproveRunResultSchema,
  NextStepSchema,
  SetStepHarnessResultSchema,
  StepAckSchema,
  type ApproveRunInput,
  type ApproveRunResult,
  type CompleteStepInput,
  type NextStep,
  type NextStepQuery,
  type SetStepHarnessResult,
  type StepAck,
  type SubmitPlanInput,
} from '@sdlc/contracts'
import {
  AgentDetailSchema,
  AgentSchema,
  ApiErrorSchema,
  CLIENT_HEADER,
  MeSchema,
  MemoryContextSchema,
  MemoryItemSchema,
  ProjectProfileSchema,
  ProjectProfileStateSchema,
  RepoBranchSchema,
  type ProjectProfile,
  type ProjectProfileState,
  type RepoBranch,
  PatchSchema,
  ProjectRunDetailSchema,
  ProjectRunSchema,
  ProjectDetailSchema,
  ProjectSummarySchema,
  AuditEntrySchema,
  type AuditEntry,
  type CreateStoryInput,
  type ProjectDetail,
  type UpdateMemoryInput,
  type UpdateStoryInput,
  SetStepAgentResultSchema,
  StorySchema,
  StoryWorkSchema,
  UserSchema,
  WorkflowSummarySchema,
  type Agent,
  type AgentDetail,
  type CreateMemoryInput,
  type Me,
  type MemoryContext,
  type MemoryContextQuery,
  type MemoryItem,
  type MemoryStatus,
  type Patch,
  type ProjectRun,
  type ProjectRunDetail,
  type ProjectSummary,
  type ReportCommitsInput,
  type ReportRunChangesInput,
  type ReportRunInput,
  type ReportWorkspaceInput,
  type SetStepAgentResult,
  type Story,
  type StoryStatus,
  type StoryWork,
  type User,
  type WorkflowDetail,
  type WorkflowSummary,
} from '@sdlc/contracts'
import type { WorkflowSpec } from '@sdlc/core'

/** A workflow spec as served by the API — checked for the shape the runtime and the tree rely on. */
const WorkflowDetailSchema = WorkflowSummarySchema.extend({
  spec: z.custom<WorkflowSpec>(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      (v as { specVersion?: number }).specVersion === 1 &&
      Array.isArray((v as { nodes?: unknown }).nodes) &&
      Array.isArray((v as { edges?: unknown }).edges),
    'Not a workflow spec',
  ),
})

export class PlatformError extends Error {
  constructor(
    message: string,
    /** HTTP status when the API answered; undefined when it couldn't be reached. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'PlatformError'
  }
}

export interface PlatformConnection {
  /** API base URL, e.g. http://127.0.0.1:4000 */
  apiUrl: string
  /** Personal access token (`sdlc_pat_…`, created on the web under Settings → VS Code). Wins over `devUser`. */
  token?: string
  /** Local-development identity (a seeded user's email), for an API running with AUTH_MODE=dev. */
  devUser?: string
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class PlatformClient {
  readonly apiUrl: string

  constructor(
    private readonly connection: PlatformConnection,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.apiUrl = connection.apiUrl.replace(/\/+$/, '')
  }

  /** Headers identifying the caller and this client (the audit log records "via extension"). */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { [CLIENT_HEADER]: 'extension', ...extra }
    if (this.connection.token) h.Authorization = `Bearer ${this.connection.token}`
    else if (this.connection.devUser) h['x-dev-user'] = this.connection.devUser
    return h
  }

  get eventsUrl(): string {
    return `${this.apiUrl}/api/v1/events`
  }

  private async request<T, Input>(
    path: string,
    schema: ZodType<T, ZodTypeDef, Input>,
    init: { method?: string; body?: object; timeoutMs?: number } = {},
  ): Promise<T> {
    // Requests have no deadline by default; a long-poll gets one, so a dropped connection cannot hang it forever.
    const controller = init.timeoutMs ? new AbortController() : undefined
    const timer = controller ? setTimeout(() => controller.abort(), init.timeoutMs) : undefined
    let res: Response
    let text: string
    try {
      try {
        res = await this.fetchImpl(`${this.apiUrl}/api/v1${path}`, {
          method: init.method ?? 'GET',
          headers: this.headers(init.body ? { 'content-type': 'application/json' } : {}),
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: controller?.signal,
        })
        text = await res.text()
      } catch (err) {
        if (controller?.signal.aborted) throw new PlatformError(`The SDLC platform API did not answer within ${Math.round((init.timeoutMs ?? 0) / 1000)} s.`)
        throw new PlatformError(
          `Cannot reach the SDLC platform API at ${this.apiUrl}${err instanceof Error ? ` (${err.message})` : ''}.`,
        )
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(json)
      throw new PlatformError(parsed.success ? parsed.data.message : `Request failed (${res.status}).`, res.status)
    }
    const result = schema.safeParse(json)
    if (!result.success) throw new PlatformError('Unexpected response from the SDLC platform API.', res.status)
    return result.data
  }

  /** Seeded users for the dev sign-in picker (only served when the API runs with AUTH_MODE=dev). */
  devUsers(): Promise<User[]> {
    return this.request('/dev/users', z.array(UserSchema))
  }

  me(): Promise<Me> {
    return this.request('/me', MeSchema)
  }

  // ─── Settings → VS Code: this window's presence and the user's preferences ──────────────────────

  /** The user's preferences and connected VS Code windows. */
  mySettings(): Promise<MySettings> {
    return this.request('/me/settings', MySettingsSchema)
  }

  /** Heartbeat for this VS Code window; answers with the user's current preferences. */
  reportPresence(clientId: string, input: ClientPresenceInput): Promise<MySettings> {
    return this.request(`/me/clients/${encodeURIComponent(clientId)}`, MySettingsSchema, { method: 'PUT', body: input })
  }

  async removePresence(clientId: string): Promise<void> {
    await this.request(`/me/clients/${encodeURIComponent(clientId)}`, z.null(), { method: 'DELETE' })
  }

  projects(): Promise<ProjectSummary[]> {
    return this.request('/projects', z.array(ProjectSummarySchema))
  }

  stories(projectKey: string): Promise<Story[]> {
    return this.request(`/projects/${encodeURIComponent(projectKey)}/stories`, z.array(StorySchema))
  }

  myStories(): Promise<Story[]> {
    return this.request('/me/stories', z.array(StorySchema))
  }

  pickUp(projectKey: string, number: number): Promise<Story> {
    return this.request(`/projects/${encodeURIComponent(projectKey)}/stories/${number}/pickup`, StorySchema, { method: 'POST' })
  }

  move(projectKey: string, number: number, to: StoryStatus): Promise<Story> {
    return this.request(`/projects/${encodeURIComponent(projectKey)}/stories/${number}/transition`, StorySchema, {
      method: 'POST',
      body: { to },
    })
  }

  story(projectKey: string, number: number): Promise<Story> {
    return this.request(storyPath(projectKey, number), StorySchema)
  }

  // ─── Code activity (reported while the developer works on a story) ─────────────────────────────

  storyWork(projectKey: string, number: number): Promise<StoryWork> {
    return this.request(`${storyPath(projectKey, number)}/work`, StoryWorkSchema)
  }

  commitDiff(projectKey: string, number: number, sha: string): Promise<Patch> {
    return this.request(`${storyPath(projectKey, number)}/commits/${encodeURIComponent(sha)}/diff`, PatchSchema)
  }

  workspaceDiff(projectKey: string, number: number, userId: string): Promise<Patch> {
    return this.request(`${storyPath(projectKey, number)}/workspace/${encodeURIComponent(userId)}/diff`, PatchSchema)
  }

  reportWorkspace(projectKey: string, number: number, input: ReportWorkspaceInput): Promise<unknown> {
    return this.request(`${storyPath(projectKey, number)}/workspace`, z.unknown(), { method: 'PUT', body: input })
  }

  clearWorkspace(projectKey: string, number: number): Promise<unknown> {
    return this.request(`${storyPath(projectKey, number)}/workspace`, z.unknown(), { method: 'DELETE' })
  }

  reportCommits(projectKey: string, number: number, input: ReportCommitsInput): Promise<{ added: number }> {
    return this.request(`${storyPath(projectKey, number)}/commits`, z.object({ added: z.number() }), { method: 'POST', body: input })
  }

  reportRun(projectKey: string, number: number, clientRunId: string, input: ReportRunInput): Promise<{ id: string }> {
    return this.request(`${storyPath(projectKey, number)}/runs/${encodeURIComponent(clientRunId)}`, z.object({ id: z.string() }), {
      method: 'PUT',
      body: input,
    })
  }

  // ─── Memory ────────────────────────────────────────────────────────────────────────────────────

  storyMemory(projectKey: string, number: number): Promise<MemoryItem[]> {
    return this.request(`${storyPath(projectKey, number)}/memory`, z.array(MemoryItemSchema))
  }

  projectMemory(projectKey: string, query: { q?: string; status?: MemoryStatus } = {}): Promise<MemoryItem[]> {
    const params = new URLSearchParams()
    if (query.q?.trim()) params.set('q', query.q.trim())
    if (query.status) params.set('status', query.status)
    const qs = params.toString()
    return this.request(`/projects/${encodeURIComponent(projectKey)}/memory${qs ? `?${qs}` : ''}`, z.array(MemoryItemSchema))
  }

  addStoryMemory(projectKey: string, number: number, input: CreateMemoryInput): Promise<MemoryItem> {
    return this.request(`${storyPath(projectKey, number)}/memory`, MemoryItemSchema, { method: 'POST', body: input })
  }

  promoteMemory(projectKey: string, id: string): Promise<MemoryItem> {
    return this.request(`/projects/${encodeURIComponent(projectKey)}/memory/${id}/promote`, MemoryItemSchema, { method: 'POST' })
  }

  /** Accept or reject a proposed project memory item (needs memory.curate). */
  decideMemory(projectKey: string, id: string, accept: boolean, comment?: string): Promise<MemoryItem> {
    return this.request(`${projectPath(projectKey)}/memory/${id}/decide`, MemoryItemSchema, { method: 'POST', body: { accept, comment } })
  }

  archiveMemory(projectKey: string, id: string): Promise<MemoryItem> {
    return this.request(`/projects/${encodeURIComponent(projectKey)}/memory/${id}/archive`, MemoryItemSchema, { method: 'POST' })
  }

  /**
   * The story and project memory an agent working on the story should be given, as Markdown. With `runId` the
   * platform records which items that run was given (`via` context files, or an agent's tool call).
   */
  memoryContext(projectKey: string, number: number, query: MemoryContextQuery = {}): Promise<MemoryContext> {
    return this.request(`${storyPath(projectKey, number)}/memory/context${memoryContextQs(query)}`, MemoryContextSchema)
  }

  /** For a quick fix (no story): project memory related to its prompt (`q`), recorded for `runId` like above. */
  projectMemoryContext(projectKey: string, query: MemoryContextQuery = {}): Promise<MemoryContext> {
    return this.request(`${projectPath(projectKey)}/memory/context${memoryContextQs(query)}`, MemoryContextSchema)
  }

  /** What a run changed against the commit it started from (only the window running it reports this). */
  reportRunChanges(projectKey: string, runId: string, input: ReportRunChangesInput): Promise<{ ok: true; files: number }> {
    // A deadline: reports of one run are queued, so a hung request would hold up the step completions behind it.
    return this.request(`${runPath(projectKey, runId)}/changes`, z.object({ ok: z.literal(true), files: z.number() }), { method: 'PUT', body: input, timeoutMs: 30_000 })
  }

  // ─── Agents & workflows ────────────────────────────────────────────────────────────────────────

  /** The project's agent catalog: built-ins plus agents/skills found in its codebase (restricted ones locked). */
  agents(projectKey: string): Promise<Agent[]> {
    return this.request(`${projectPath(projectKey)}/agents`, z.array(AgentSchema))
  }

  agent(projectKey: string, slug: string): Promise<AgentDetail> {
    return this.request(`${projectPath(projectKey)}/agents/${encodeURIComponent(slug)}`, AgentDetailSchema)
  }

  setAgentEnabled(projectKey: string, slug: string, enabled: boolean): Promise<unknown> {
    return this.request(`${projectPath(projectKey)}/agents/${encodeURIComponent(slug)}`, z.unknown(), { method: 'PUT', body: { enabled } })
  }

  workflows(projectKey: string): Promise<WorkflowSummary[]> {
    return this.request(`${projectPath(projectKey)}/workflows`, z.array(WorkflowSummarySchema))
  }

  workflow(projectKey: string, id: string): Promise<WorkflowDetail> {
    return this.request(`${projectPath(projectKey)}/workflows/${encodeURIComponent(id)}`, WorkflowDetailSchema)
  }

  /** Map an agent (by slug) onto one agent step of a project workflow; null unbinds it. */
  setStepAgent(projectKey: string, workflowId: string, nodeId: string, agentSlug: string | null): Promise<SetStepAgentResult> {
    return this.request(
      `${projectPath(projectKey)}/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/agent`,
      SetStepAgentResultSchema,
      { method: 'PUT', body: { agentSlug } },
    )
  }

  /** Every agent run reported in the project (all stories, all developers), newest first. */
  projectRuns(projectKey: string, limit = 50): Promise<ProjectRun[]> {
    return this.request(`${projectPath(projectKey)}/runs?limit=${limit}`, z.array(ProjectRunSchema))
  }

  projectRun(projectKey: string, id: string): Promise<ProjectRunDetail> {
    return this.request(`${projectPath(projectKey)}/runs/${encodeURIComponent(id)}`, ProjectRunDetailSchema)
  }

  // ─── Story editing + project memory (parity with the web app's board, story page and Memory page) ──

  /** The project with its members and the caller's permissions (for pickers and showing/hiding actions). */
  project(projectKey: string): Promise<ProjectDetail> {
    return this.request(projectPath(projectKey), ProjectDetailSchema)
  }

  createStory(projectKey: string, input: CreateStoryInput): Promise<Story> {
    return this.request(`${projectPath(projectKey)}/stories`, StorySchema, { method: 'POST', body: input })
  }

  /** Edit a story; `input.version` must be the version the edit is based on (a stale one is rejected with 409). */
  updateStory(projectKey: string, number: number, input: UpdateStoryInput): Promise<Story> {
    return this.request(storyPath(projectKey, number), StorySchema, { method: 'PATCH', body: input })
  }

  /** Assign the story to a project member; null unassigns it. */
  assignStory(projectKey: string, number: number, userId: string | null): Promise<Story> {
    return this.request(`${storyPath(projectKey, number)}/assign`, StorySchema, { method: 'POST', body: { userId } })
  }

  /** The story's activity, newest first; pass the last entry's id as `before` for the next page. */
  storyActivity(projectKey: string, number: number, before?: number): Promise<AuditEntry[]> {
    return this.request(`${storyPath(projectKey, number)}/activity${before ? `?before=${before}` : ''}`, z.array(AuditEntrySchema))
  }

  /** Add an item straight to project memory (accepted for curators, proposed for everyone else). */
  addProjectMemory(projectKey: string, input: CreateMemoryInput): Promise<MemoryItem> {
    return this.request(`${projectPath(projectKey)}/memory`, MemoryItemSchema, { method: 'POST', body: input })
  }

  // ─── Project profile ─────────────────────────────────────────────────────────────────────────────

  /** The accepted project profile, the update waiting for review (or a generation in progress) and what you may do. */
  projectProfile(projectKey: string): Promise<ProjectProfileState> {
    return this.request(`${projectPath(projectKey)}/profile`, ProjectProfileStateSchema)
  }

  /** Have the built-in Project profiler write the profile from a branch of the linked repository (in the background). */
  generateProjectProfile(projectKey: string, branch?: string): Promise<ProjectProfile> {
    return this.request(`${projectPath(projectKey)}/profile/generate`, ProjectProfileSchema, { method: 'POST', body: branch ? { branch } : {} })
  }

  /** Accept or reject a profile update proposed after runs (needs memory.curate). */
  decideProjectProfile(projectKey: string, id: string, decision: 'accept' | 'reject', comment?: string): Promise<ProjectProfile> {
    return this.request(`${projectPath(projectKey)}/profile/versions/${encodeURIComponent(id)}/decide`, ProjectProfileSchema, { method: 'POST', body: { decision, comment } })
  }

  /** Branches of the linked repository (`indexedSha` null = not loaded on the platform yet). */
  repoBranches(projectKey: string): Promise<RepoBranch[]> {
    return this.request(`${projectPath(projectKey)}/code/branches`, z.array(RepoBranchSchema))
  }

  /** Load a branch's files on the platform (null when they are already current). */
  openRepoBranch(projectKey: string, branch: string): Promise<unknown> {
    return this.request(`${projectPath(projectKey)}/code/branches/index?branch=${encodeURIComponent(branch)}`, z.unknown(), { method: 'POST' })
  }

  /** Edit a memory item, or pin / unpin it for every agent. */
  updateMemory(projectKey: string, id: string, input: UpdateMemoryInput): Promise<MemoryItem> {
    return this.request(`${projectPath(projectKey)}/memory/${encodeURIComponent(id)}`, MemoryItemSchema, { method: 'PATCH', body: input })
  }

  // ─── Harness runs ───────────────────────────────────────────────────────────────────────────────

  /** Start a story or task in a harness (from VS Code: target this window, then claim it straight away). */
  requestRun(projectKey: string, input: RequestRunInput): Promise<RequestRunResult> {
    return this.request(`${projectPath(projectKey)}/runs`, RequestRunResultSchema, { method: 'POST', body: input })
  }

  /** Runs I started from the web that are waiting for one of my VS Code windows. */
  pendingRuns(): Promise<PendingRuns> {
    return this.request('/me/runs/pending', PendingRunsSchema)
  }

  /** My runs that have not ended, with the agent steps waiting for a harness (the run monitor; resuming after a reload). */
  activeRuns(): Promise<ActiveRun[]> {
    return this.request('/me/runs/active', ActiveRunsSchema)
  }

  /** Cancel a run; `reason` is kept as its error (declined here, or it could not start here). */
  cancelRun(projectKey: string, runId: string, reason?: string): Promise<{ ok: true; delivered: boolean }> {
    return this.request(`${runPath(projectKey, runId)}/cancel`, z.object({ ok: z.literal(true), delivered: z.boolean() }), {
      method: 'POST',
      body: reason ? { reason: reason.slice(0, 2_000) } : {},
    })
  }

  /** Take a run started from the web (idempotent for this window). */
  claimRun(runId: string, clientId: string): Promise<RunLaunch> {
    return this.request(`/runs/${encodeURIComponent(runId)}/claim`, RunLaunchSchema, { method: 'POST', body: { clientId } })
  }

  /** Append a run's activity (idempotent on each event's seq). */
  reportRunEvents(projectKey: string, runId: string, input: ReportRunEventsInput): Promise<{ lastSeq: number }> {
    return this.request(`${projectPath(projectKey)}/runs/${encodeURIComponent(runId)}/events`, z.object({ lastSeq: z.number() }), {
      method: 'POST',
      body: input,
    })
  }

  /** A run's activity after `after` (the run monitor reads only what is new). */
  runEvents(projectKey: string, runId: string, after = -1): Promise<RunEventsPage> {
    return this.request(`${projectPath(projectKey)}/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=1000`, RunEventsPageSchema)
  }

  /** The tasks under a story. */
  storyTasks(projectKey: string, number: number): Promise<StoryTask[]> {
    return this.request(`${storyPath(projectKey, number)}/tasks`, z.array(StoryTaskSchema))
  }

  // ─── Orchestrator-driven runs: the platform drives the workflow, a harness here works each agent step ──

  /** The agent step for `harness` to work on now. Long-polls up to `query.wait` seconds (default 25) for work. */
  nextStep(projectKey: string, runId: string, query: NextStepQuery): Promise<NextStep> {
    const wait = Math.min(50, Math.max(0, Math.round(query.wait ?? 25)))
    const params = new URLSearchParams({ harness: query.harness, wait: String(wait) })
    if (query.clientId) params.set('clientId', query.clientId)
    return this.request(`${runPath(projectKey, runId)}/steps/next?${params.toString()}`, NextStepSchema, { timeoutMs: (wait + 15) * 1000 })
  }

  /** Submit the plan for a step in its plan phase; the run then waits for a human to approve it. */
  submitPlan(projectKey: string, runId: string, stepId: string, input: SubmitPlanInput): Promise<StepAck> {
    return this.request(`${runPath(projectKey, runId)}/steps/${encodeURIComponent(stepId)}/plan`, StepAckSchema, { method: 'POST', body: input })
  }

  /** Finish a step in its execute phase: its summary is the step's output, `outputs` set run variables. */
  completeStep(projectKey: string, runId: string, stepId: string, input: CompleteStepInput): Promise<StepAck> {
    return this.request(`${runPath(projectKey, runId)}/steps/${encodeURIComponent(stepId)}/complete`, StepAckSchema, {
      method: 'POST',
      body: input,
    })
  }

  /** Approve or reject what the run is waiting on (a plan, or an approval step). */
  approveRun(projectKey: string, runId: string, input: ApproveRunInput): Promise<ApproveRunResult> {
    return this.request(`${runPath(projectKey, runId)}/approval`, ApproveRunResultSchema, { method: 'POST', body: input })
  }

  /** Pin an agent step of a project workflow to a harness; null = the harness the run starts with. */
  setStepHarness(projectKey: string, workflowId: string, nodeId: string, harness: string | null): Promise<SetStepHarnessResult> {
    return this.request(
      `${projectPath(projectKey)}/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/harness`,
      SetStepHarnessResultSchema,
      { method: 'PUT', body: { harness } },
    )
  }
}

function memoryContextQs(query: MemoryContextQuery): string {
  const params = new URLSearchParams()
  if (query.runId) params.set('runId', query.runId)
  if (query.stepId) params.set('stepId', query.stepId)
  if (query.via) params.set('via', query.via)
  if (query.q?.trim()) params.set('q', query.q.trim().slice(0, 4_000))
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

function runPath(projectKey: string, runId: string): string {
  return `${projectPath(projectKey)}/runs/${encodeURIComponent(runId)}`
}

function projectPath(projectKey: string): string {
  return `/projects/${encodeURIComponent(projectKey)}`
}

function storyPath(projectKey: string, number: number): string {
  return `/projects/${encodeURIComponent(projectKey)}/stories/${number}`
}
