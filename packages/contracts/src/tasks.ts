// Tasks: units of work under a story, like a GitHub issue or an Azure Boards Task under a user story. Each can be
// started on its own — it runs through the project's workflow (agents, skills, gates) in the developer's chosen
// harness, on its story's branch. Tasks are native; `external` links one to the GitHub issue or Boards work item it
// mirrors, so a sync can be added later without changing the model.

import { z } from 'zod'
import { RunSummarySchema, UserSchema, type RunSummary } from './schemas'

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
}

export const TASK_EXTERNAL_PROVIDERS = ['github', 'azure-boards'] as const
export type TaskExternalProvider = (typeof TASK_EXTERNAL_PROVIDERS)[number]

export const TASK_EXTERNAL_PROVIDER_LABELS: Record<TaskExternalProvider, string> = {
  github: 'GitHub issue',
  'azure-boards': 'Azure Boards task',
}

export const TaskExternalLinkSchema = z.object({
  provider: z.enum(TASK_EXTERNAL_PROVIDERS),
  /** The issue number or work item id, as text (`123`, `owner/repo#123`). */
  externalId: z.string().trim().min(1).max(200),
  url: z.string().trim().url().max(2_000),
})
export type TaskExternalLink = z.infer<typeof TaskExternalLinkSchema>

/** The latest run of a task, for its row in the task list. */
/** A task's latest run (the same shape as a story's, see RunSummarySchema). */
export const TaskRunSummarySchema = RunSummarySchema
export type TaskRunSummary = RunSummary

export const StoryTaskSchema = z.object({
  id: z.string().uuid(),
  storyNumber: z.number().int(),
  /** Per story: T1, T2, … */
  number: z.number().int(),
  /** `PAY-2/T1`. */
  key: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  assignee: UserSchema.nullable(),
  rank: z.number(),
  external: TaskExternalLinkSchema.nullable(),
  latestRun: TaskRunSummarySchema.nullable(),
  createdBy: UserSchema,
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type StoryTask = z.infer<typeof StoryTaskSchema>

export const CreateTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).default(''),
  assigneeId: z.string().uuid().nullable().optional(),
  external: TaskExternalLinkSchema.nullable().optional(),
})
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>

export const UpdateTaskInputSchema = z.object({
  /** The version the edit is based on; a stale version is rejected with 409. */
  version: z.number().int(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(10_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  external: TaskExternalLinkSchema.nullable().optional(),
  rank: z.number().optional(),
})
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>

export const TaskParamsSchema = z.object({ taskNumber: z.coerce.number().int().positive() })

/** `PAY-2/T1`. */
export function taskKey(storyKey: string, taskNumber: number): string {
  return `${storyKey}/T${taskNumber}`
}
