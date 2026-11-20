// Runs: the agent runs of a project (started from the web or VS Code), what happened in one, the user's VS Code
// windows and their installed harnesses, and starting or cancelling a run in the user's VS Code.

import { z } from 'zod'
import { RequestRunInputSchema, RunListQuerySchema, RUN_STATUSES, type ProjectRun } from '@sdlc/contracts'
import { parse } from '../../http'
import * as sessionService from '../../services/sessions'
import { clientsOf } from '../../services/settings'
import * as workService from '../../services/work'
import { defineChatTool, projectOf, PROJECT_FIELD_DESCRIPTION } from './kit'

const project = z.string().nullable().describe(PROJECT_FIELD_DESCRIPTION)
const runId = z.string().describe('Run id (from list_runs).')

const run = (r: ProjectRun) => ({
  id: r.id,
  story: r.story?.key ?? null,
  task: r.task?.key ?? null,
  workflow: r.workflowName,
  engine: r.engine,
  status: r.status,
  startedBy: r.startedBy?.displayName ?? r.requestedBy?.displayName ?? null,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  error: r.error,
  pendingApproval: r.pendingApproval?.question ?? null,
  steps: r.stepCount,
  gates: { passed: r.gatesPassed, failed: r.gatesFailed },
  changedFiles: r.changedFiles.length,
})

export const runTools = [
  defineChatTool({
    name: 'list_runs',
    label: 'List runs',
    access: 'read',
    description: "A project's agent runs, newest first, optionally filtered by status or story.",
    input: z.object({
      project,
      status: z.enum(RUN_STATUSES).nullable(),
      storyNumber: z.number().int().positive().nullable(),
      limit: z.number().int().min(1).max(50).describe('How many (newest first).'),
    }),
    execute: async (ctx, { project: key, status, storyNumber, limit }) => {
      const query = parse(RunListQuerySchema, { ...(status ? { status } : {}), ...(storyNumber ? { story: storyNumber } : {}), limit })
      return (await workService.projectRuns(ctx.deps.db, ctx.caller.user, projectOf(ctx, key), query)).map(run)
    },
  }),
  defineChatTool({
    name: 'get_run',
    label: 'Read run',
    access: 'read',
    description: 'One run: its steps with status and evaluations, and the latest activity events.',
    input: z.object({ project, runId }),
    execute: async (ctx, { project: key, runId: id }) => {
      const k = projectOf(ctx, key)
      const [detail, page] = await Promise.all([
        workService.projectRun(ctx.deps.db, ctx.caller.user, k, id),
        sessionService.listRunEvents(ctx.deps.db, ctx.caller.user, k, id, { after: -1, limit: 1000 }),
      ])
      return {
        ...run(detail),
        stepsDetail: detail.steps.map((s) => ({ step: s.stepId, label: s.label, agent: s.agentName, status: s.status, error: s.error })),
        latestEvents: page.events.slice(-25).map((e) => ({ at: e.at, type: e.type, step: e.stepId, tool: e.tool, path: e.path, summary: e.summary })),
      }
    },
  }),
  defineChatTool({
    name: 'my_vscode_windows',
    label: 'My VS Code windows',
    access: 'read',
    description: "The user's VS Code windows signed in to the platform: which are online, their workspace, and the agent harnesses installed in each (needed to start a run).",
    input: z.object({}),
    execute: async (ctx) =>
      (await clientsOf(ctx.deps.db, ctx.caller.user.id)).map((c) => ({
        clientId: c.clientId,
        online: c.online,
        workspace: c.workspace?.name ?? null,
        branch: c.workspace?.branch ?? null,
        harnesses: c.engines.filter((e) => e.installed).map((e) => ({ id: e.engine, label: e.label ?? e.engine })),
        lastSeenAt: c.lastSeenAt,
      })),
  }),
  defineChatTool({
    name: 'start_run',
    label: 'Start run in VS Code',
    access: 'write',
    permission: 'work.report',
    description:
      "Start a story (or one of its tasks) — or, with no story, a quick fix described by `prompt` — in the user's VS Code with a workflow and a harness installed there (see my_vscode_windows and list_workflows). With a story, `prompt` is extra instructions. The run is picked up by the chosen window, or any online window with that harness.",
    input: z.object({
      project,
      storyNumber: z.number().int().positive().nullable().describe('null for a quick fix with no story.'),
      taskNumber: z.number().int().positive().nullable(),
      prompt: z.string().max(4000).nullable().describe('The quick fix to make (required without a story), or extra instructions for the story.'),
      workflowId: z.string(),
      harness: z.string().describe('Harness id, e.g. "claude-code", "codex", "copilot".'),
      clientId: z.string().nullable().describe('A specific window; null = any online window with the harness.'),
    }),
    execute: async (ctx, i) => {
      const input = parse(RequestRunInputSchema, {
        storyNumber: i.storyNumber,
        taskNumber: i.taskNumber,
        prompt: i.prompt,
        workflowId: i.workflowId,
        engine: i.harness,
        clientId: i.clientId,
      })
      const result = await sessionService.requestRun(ctx.deps, ctx.caller, projectOf(ctx, i.project), input)
      return { ok: true, runId: result.run.id, status: result.run.status }
    },
  }),
  defineChatTool({
    name: 'cancel_run',
    label: 'Cancel run',
    access: 'write',
    permission: 'work.report',
    description: 'Cancel a run that has not finished (your own, or any run if you can assign stories).',
    input: z.object({ project, runId }),
    execute: async (ctx, { project: key, runId: id }) => sessionService.cancelRun(ctx.deps, ctx.caller, projectOf(ctx, key), id),
  }),
]
