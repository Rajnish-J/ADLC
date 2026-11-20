// Starting a story or task in your VS Code harness, cancelling a run, the run's activity log, tasks under a story,
// and the skills on a workflow step.

import { z } from 'zod'
import {
  ActiveRunsSchema,
  ApproveRunResultSchema,
  RequestRunResultSchema,
  RunEventsPageSchema,
  SetStepSkillsResultSchema,
  StoryTaskSchema,
  type ActiveRun,
  type ApproveRunInput,
  type ApproveRunResult,
  type CreateTaskInput,
  type RequestRunInput,
  type RequestRunResult,
  type RunEventsPage,
  type SetStepSkillsResult,
  type StoryTask,
  type UpdateTaskInput,
} from '@sdlc/contracts'
import { apiRequest } from './http'

const projectPath = (key: string): string => `/projects/${encodeURIComponent(key)}`
const storyPath = (key: string, number: number): string => `${projectPath(key)}/stories/${number}`

// ─── Runs in a harness ───────────────────────────────────────────────────────────────────────────

/** Ask your VS Code to start the workflow on a story (or task) in the chosen harness. */
export function requestRun(key: string, input: RequestRunInput): Promise<RequestRunResult> {
  return apiRequest(`${projectPath(key)}/runs`, RequestRunResultSchema, { method: 'POST', body: input })
}

export function cancelRun(key: string, runId: string): Promise<{ ok: true; delivered: boolean }> {
  return apiRequest(`${projectPath(key)}/runs/${runId}/cancel`, z.object({ ok: z.literal(true), delivered: z.boolean() }), { method: 'POST' })
}

/**
 * Approve or reject the step a platform-driven run is waiting on. Pass the pending step's id so a decision never lands
 * on a step the run has already moved past.
 */
export function approveRun(key: string, runId: string, input: ApproveRunInput): Promise<ApproveRunResult> {
  return apiRequest(`${projectPath(key)}/runs/${runId}/approval`, ApproveRunResultSchema, { method: 'POST', body: input })
}

/** My runs that have not ended (any project), newest first — the run monitor's list. */
export function listActiveRuns(): Promise<ActiveRun[]> {
  return apiRequest('/me/runs/active', ActiveRunsSchema)
}

export function listRunEvents(key: string, runId: string, after = -1): Promise<RunEventsPage> {
  return apiRequest(`${projectPath(key)}/runs/${runId}/events?after=${after}&limit=1000`, RunEventsPageSchema)
}

// ─── Tasks ───────────────────────────────────────────────────────────────────────────────────────

export function listTasks(key: string, number: number): Promise<StoryTask[]> {
  return apiRequest(`${storyPath(key, number)}/tasks`, z.array(StoryTaskSchema))
}

export function createTask(key: string, number: number, input: CreateTaskInput): Promise<StoryTask> {
  return apiRequest(`${storyPath(key, number)}/tasks`, StoryTaskSchema, { method: 'POST', body: input })
}

export function updateTask(key: string, number: number, taskNumber: number, input: UpdateTaskInput): Promise<StoryTask> {
  return apiRequest(`${storyPath(key, number)}/tasks/${taskNumber}`, StoryTaskSchema, { method: 'PATCH', body: input })
}

export function deleteTask(key: string, number: number, taskNumber: number): Promise<{ ok: true }> {
  return apiRequest(`${storyPath(key, number)}/tasks/${taskNumber}`, z.object({ ok: z.literal(true) }), { method: 'DELETE' })
}

// ─── Skills on a workflow step ───────────────────────────────────────────────────────────────────

export function setStepSkills(key: string, workflowId: string, nodeId: string, skills: string[]): Promise<SetStepSkillsResult> {
  return apiRequest(
    `${projectPath(key)}/workflows/${workflowId}/nodes/${encodeURIComponent(nodeId)}/skills`,
    SetStepSkillsResultSchema,
    { method: 'PUT', body: { skills } },
  )
}
