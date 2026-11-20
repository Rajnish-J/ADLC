// The SDLC tools a harness calls (over MCP on the local bridge) to run a workflow step by step: get the next step,
// submit a plan, complete a step, and read the story and memory or add to it. One implementation for every harness.

import { MEMORY_KINDS, type MemoryContext } from '@sdlc/contracts'
import type { BridgeTool } from '../bridge/localBridge'
import type { PlatformClient } from '../platformClient'
import type { ActivityReporter } from './activityReporter'
import type { SessionFiles } from './sessionFiles'
import type { StepSource } from './stepSource'

export interface SdlcToolContext {
  runId: string
  projectKey: string
  /** null for a quick fix (no story): the work item is `prompt.md`, and memory is the project's. */
  storyNumber: number | null
  /** A quick fix's prompt (or a story run's extra instructions), to find related project memory. */
  prompt?: string | null
  sessionDir: string
  /** Where the steps come from: the local step channel, or the platform's orchestrator (RemoteStepSource). */
  steps: StepSource
  client: () => PlatformClient | undefined
  files: SessionFiles
  activity: () => ActivityReporter | undefined
  currentStep: () => string | undefined
}

const text = (v: unknown, name: string, max = 20_000): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${name}" is required.`)
  return v.slice(0, max)
}

const MAX_OUTPUTS_CHARS = 20_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RunMemoryOptions {
  /** The platform run being given the memory (recorded on its page). */
  runId?: string
  stepId?: string | null
  /** Written into the session's context files at the start, or fetched by an agent's tool call. */
  via?: 'context' | 'tool'
  /** A quick fix's prompt: project knowledge related to it comes first. */
  prompt?: string | null
}

/**
 * The knowledge a run works with, as markdown: the story's memory context (story + project), or — for a quick fix
 * with no story — the project's knowledge related to its prompt. Passing the run records which items it was given.
 */
export async function runMemoryContext(client: PlatformClient, projectKey: string, storyNumber: number | null, opts: RunMemoryOptions = {}): Promise<MemoryContext> {
  const query = {
    ...(opts.runId && UUID.test(opts.runId) ? { runId: opts.runId } : {}),
    ...(opts.stepId ? { stepId: opts.stepId } : {}),
    via: opts.via ?? 'context',
    ...(opts.prompt?.trim() ? { q: opts.prompt.trim().slice(0, 4_000) } : {}),
  }
  return storyNumber != null ? client.memoryContext(projectKey, storyNumber, query) : client.projectMemoryContext(projectKey, query)
}

export async function runMemoryMarkdown(client: PlatformClient, projectKey: string, storyNumber: number | null, opts: RunMemoryOptions = {}): Promise<string | undefined> {
  return (await runMemoryContext(client, projectKey, storyNumber, opts)).markdown || undefined
}

/** The optional `outputs` of sdlc_complete_step: a JSON object of run variables, or undefined. */
export function stepOutputs(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('"outputs" must be an object of run variables, e.g. {"Local.TestsPassed": true}.')
  const out = v as Record<string, unknown>
  if (Object.keys(out).length === 0) return undefined
  if (JSON.stringify(out).length > MAX_OUTPUTS_CHARS) throw new Error(`"outputs" is too large (max ${MAX_OUTPUTS_CHARS} characters as JSON).`)
  return out
}

export function buildSdlcTools(ctx: SdlcToolContext): BridgeTool[] {
  return [
    {
      name: 'sdlc_next_step',
      description:
        'Get your current SDLC workflow step: which agent to act as (with its instructions), the skills you may use, and whether to PLAN or EXECUTE. ' +
        'Returns action "waiting" while a human reviews your plan or a gate runs — call it again. Returns "handoff" when another harness has the next step — then end your turn. ' +
        'Returns "done" or "stopped" when the run is over.',
      inputSchema: {
        type: 'object',
        properties: { waitSeconds: { type: 'number', description: 'How long to wait for work (default 40, max 50).' } },
      },
      call: async (args) => {
        const wait = Math.min(50, Math.max(1, Number(args.waitSeconds) || 40)) * 1000
        return ctx.steps.poll(ctx.runId, wait)
      },
    },
    {
      name: 'sdlc_submit_plan',
      description:
        'Submit your plan for the current step (action "plan"). Do not change files before the plan is approved. ' +
        'Then call sdlc_next_step: it returns "execute" with the approved plan once a human approves it.',
      inputSchema: {
        type: 'object',
        properties: { stepId: { type: 'string' }, plan: { type: 'string', description: 'A concrete plan: what you will change and why.' } },
        required: ['stepId', 'plan'],
      },
      call: async (args) => {
        await ctx.steps.submitPlan(ctx.runId, text(args.stepId, 'stepId', 200), text(args.plan, 'plan', 4_000))
        return { ok: true, next: 'Call sdlc_next_step to wait for approval.' }
      },
    },
    {
      name: 'sdlc_complete_step',
      description:
        'Finish the current step (action "execute") with a short summary of what you changed, the skills you used, ' +
        'and optionally `outputs` — run variables this step sets for later conditions.',
      inputSchema: {
        type: 'object',
        properties: {
          stepId: { type: 'string' },
          summary: { type: 'string', description: 'What you did and which files changed. The next step builds on it.' },
          skillsUsed: { type: 'array', items: { type: 'string' }, description: 'Slugs of the skills you used in this step.' },
          outputs: {
            type: 'object',
            description: 'Optional. Run variables this step sets, e.g. {"Local.TestsPassed": true}, for later conditions in the workflow to branch on.',
            additionalProperties: true,
          },
        },
        required: ['stepId', 'summary'],
      },
      call: async (args) => {
        const skills = Array.isArray(args.skillsUsed) ? args.skillsUsed.filter((s): s is string => typeof s === 'string').slice(0, 20) : []
        const outputs = stepOutputs(args.outputs)
        await ctx.steps.complete(ctx.runId, text(args.stepId, 'stepId', 200), text(args.summary, 'summary', 8_000), {
          skillsUsed: skills,
          ...(outputs ? { outputs } : {}),
        })
        return { ok: true, next: 'Call sdlc_next_step for the next step.' }
      },
    },
    {
      name: 'sdlc_get_story',
      description: 'What you are working on: the story (and task) with its description and acceptance criteria, or the quick fix to make.',
      inputSchema: { type: 'object', properties: {} },
      call: async () =>
        ctx.storyNumber != null
          ? ((await ctx.files.read(`${ctx.sessionDir}/story.md`)) ?? 'The story file is missing.')
          : ((await ctx.files.read(`${ctx.sessionDir}/prompt.md`)) ?? 'The prompt file is missing.'),
    },
    {
      name: 'sdlc_get_memory',
      description: 'The project knowledge (and the story’s memory, if there is a story): decisions, conventions and learnings to follow.',
      inputSchema: { type: 'object', properties: {} },
      call: async () => {
        const client = ctx.client()
        const stepId = ctx.currentStep() ?? null
        const memory = client
          ? await runMemoryContext(client, ctx.projectKey, ctx.storyNumber, { runId: ctx.runId, stepId, via: 'tool', prompt: ctx.prompt }).catch(() => undefined)
          : undefined
        ctx.activity()?.add({
          type: 'memory.read',
          stepId,
          summary: ctx.storyNumber != null ? 'Read story and project memory' : 'Read project memory',
          ...(memory ? { data: { items: memory.itemIds.length, itemIds: memory.itemIds.slice(0, 50) } } : {}),
        })
        return memory?.markdown || ((await ctx.files.read(`${ctx.sessionDir}/memory.md`)) ?? 'No memory yet.')
      },
    },
    {
      name: 'sdlc_add_memory',
      description:
        'Record something worth keeping: a decision, a convention, a learning or a note — on the story, or proposed as project knowledge for a quick fix.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...MEMORY_KINDS] },
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
      },
      call: async (args) => {
        const client = ctx.client()
        if (!client) throw new Error('Not connected to the platform.')
        const kind = MEMORY_KINDS.includes(args.kind as (typeof MEMORY_KINDS)[number]) ? (args.kind as (typeof MEMORY_KINDS)[number]) : 'note'
        const stepId = ctx.currentStep() ?? null
        const input = {
          kind,
          title: text(args.title, 'title', 200),
          content: text(args.content, 'content', 20_000),
          ...(UUID.test(ctx.runId) ? { runId: ctx.runId, ...(stepId ? { stepId } : {}) } : {}),
        }
        const item =
          ctx.storyNumber != null ? await client.addStoryMemory(ctx.projectKey, ctx.storyNumber, input) : await client.addProjectMemory(ctx.projectKey, input)
        ctx.activity()?.add({ type: 'memory.written', stepId, summary: `${kind}: ${item.title}`, data: { itemId: item.id, status: item.status } })
        return { ok: true, id: item.id, status: item.status }
      },
    },
  ]
}
