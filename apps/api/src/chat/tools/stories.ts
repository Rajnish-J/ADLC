// Stories and their tasks: read, and the direct changes (edit, move, assign, pick up, tasks). New stories are
// built as a draft (batch) and created by the user through Review & submit.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { STORY_PRIORITIES, STORY_STATUSES, TASK_STATUSES, type Story } from '@sdlc/contracts'
import * as storyService from '../../services/stories'
import * as taskService from '../../services/tasks'
import { clip, defineChatTool, person, projectOf, PROJECT_FIELD_DESCRIPTION } from './kit'

const project = z.string().nullable().describe(PROJECT_FIELD_DESCRIPTION)
const storyNumber = z.number().int().positive().describe('Story number (PAY-42 → 42).')

const summary = (s: Story) => ({
  key: s.key,
  number: s.number,
  title: s.title,
  status: s.status,
  priority: s.priority,
  assignee: s.assignee?.displayName ?? null,
  isBlocked: s.isBlocked,
  dueDate: s.dueDate,
  labels: s.labels,
})

export const storyTools = [
  defineChatTool({
    name: 'list_stories',
    label: 'List stories',
    access: 'read',
    description: "A project's stories (key, title, status, priority, assignee, blocked, due date, labels), optionally filtered.",
    input: z.object({
      project,
      status: z.enum(STORY_STATUSES).nullable().describe('Only this status; null = all.'),
      text: z.string().nullable().describe('Only stories whose title contains this; null = all.'),
      assignee: z.string().nullable().describe('Only stories assigned to someone whose name contains this, "me", or "nobody"; null = all.'),
    }),
    execute: async (ctx, { project: key, status, text, assignee }) => {
      const all = await storyService.listStories(ctx.deps.db, ctx.caller.user, projectOf(ctx, key))
      const t = text?.toLowerCase()
      const who = assignee?.toLowerCase()
      const rows = all.filter(
        (s) =>
          (!status || s.status === status) &&
          (!t || s.title.toLowerCase().includes(t)) &&
          (!who ||
            (who === 'nobody' ? !s.assignee : who === 'me' ? s.assignee?.id === ctx.caller.user.id : (s.assignee?.displayName.toLowerCase().includes(who) ?? false))),
      )
      return { total: rows.length, stories: rows.slice(0, 100).map(summary) }
    },
  }),
  defineChatTool({
    name: 'my_stories',
    label: 'My stories',
    access: 'read',
    description: 'Stories assigned to the user, across all projects.',
    input: z.object({}),
    execute: async (ctx) => (await storyService.myStories(ctx.deps.db, ctx.caller.user)).map((s) => ({ project: s.projectKey, ...summary(s) })),
  }),
  defineChatTool({
    name: 'get_story',
    label: 'Read story',
    access: 'read',
    description: 'One story in full: description, acceptance criteria, blocker, assignee, what the user may do, and its tasks.',
    input: z.object({ project, number: storyNumber }),
    execute: async (ctx, { project: key, number }) => {
      const k = projectOf(ctx, key)
      const [s, tasks] = await Promise.all([
        storyService.getStory(ctx.deps.db, ctx.caller.user, k, number),
        taskService.listTasks(ctx.deps.db, ctx.caller.user, k, number),
      ])
      return {
        ...summary(s),
        description: clip(s.description, 6000),
        acceptanceCriteria: s.acceptanceCriteria.map((c) => ({ text: c.text, met: c.met })),
        blockedReason: s.blockedReason,
        assignee: person(s.assignee),
        createdBy: s.createdBy.displayName,
        allowedTransitions: s.actions.transitions.map((t) => t.to),
        canEdit: s.actions.canEdit,
        tasks: tasks.map((t) => ({ number: t.number, key: t.key, title: t.title, status: t.status, assignee: t.assignee?.displayName ?? null })),
      }
    },
  }),
  defineChatTool({
    name: 'update_story',
    label: 'Edit story',
    access: 'write',
    permission: 'story.edit',
    description:
      'Edit a story. Only send what changes (null = keep). Title, priority, due date and the criteria list need lead or owner. acceptanceCriteria replaces the whole list (criteria with unchanged text keep their met state).',
    input: z.object({
      project,
      number: storyNumber,
      title: z.string().max(200).nullable(),
      description: z.string().max(10_000).nullable(),
      priority: z.enum(STORY_PRIORITIES).nullable(),
      labels: z.array(z.string().max(32)).max(10).nullable(),
      dueDate: z.string().nullable().describe('YYYY-MM-DD, "none" to clear, or null to keep.'),
      acceptanceCriteria: z.array(z.string().max(500)).max(30).nullable(),
      blocked: z.boolean().nullable(),
      blockedReason: z.string().max(500).nullable(),
    }),
    execute: async (ctx, i) => {
      const k = projectOf(ctx, i.project)
      const current = await storyService.getStory(ctx.deps.db, ctx.caller.user, k, i.number)
      const byText = new Map(current.acceptanceCriteria.map((c) => [c.text.trim(), c]))
      const s = await storyService.updateStory(ctx.deps, ctx.caller, k, i.number, {
        version: current.version,
        ...(i.title !== null ? { title: i.title } : {}),
        ...(i.description !== null ? { description: i.description } : {}),
        ...(i.priority !== null ? { priority: i.priority } : {}),
        ...(i.labels !== null ? { labels: i.labels } : {}),
        ...(i.dueDate !== null ? { dueDate: i.dueDate === 'none' ? null : i.dueDate } : {}),
        ...(i.acceptanceCriteria !== null
          ? { acceptanceCriteria: i.acceptanceCriteria.map((text) => byText.get(text.trim()) ?? { id: randomUUID(), text, met: false }) }
          : {}),
        ...(i.blocked !== null ? { isBlocked: i.blocked } : {}),
        ...(i.blockedReason !== null ? { blockedReason: i.blockedReason } : {}),
      })
      return { ok: true, story: summary(s) }
    },
  }),
  defineChatTool({
    name: 'transition_story',
    label: 'Move story',
    access: 'write',
    permission: 'story.transition',
    description: 'Move a story to another status (see allowedTransitions from get_story).',
    input: z.object({ project, number: storyNumber, to: z.enum(STORY_STATUSES) }),
    execute: async (ctx, { project: key, number, to }) => ({
      ok: true,
      story: summary(await storyService.transitionStory(ctx.deps, ctx.caller, projectOf(ctx, key), number, { to })),
    }),
  }),
  defineChatTool({
    name: 'assign_story',
    label: 'Assign story',
    access: 'write',
    permission: 'story.assign',
    description: 'Assign a story to a project member (user id from get_project or find_people), or unassign with null.',
    input: z.object({ project, number: storyNumber, userId: z.string().nullable() }),
    execute: async (ctx, { project: key, number, userId }) => ({
      ok: true,
      story: summary(await storyService.assignStory(ctx.deps, ctx.caller, projectOf(ctx, key), number, { userId })),
    }),
  }),
  defineChatTool({
    name: 'pick_up_story',
    label: 'Pick up story',
    access: 'write',
    permission: 'story.pickup',
    description: 'Assign a ready story to the user themself and start it.',
    input: z.object({ project, number: storyNumber }),
    execute: async (ctx, { project: key, number }) => ({
      ok: true,
      story: summary(await storyService.pickUpStory(ctx.deps, ctx.caller, projectOf(ctx, key), number)),
    }),
  }),
  defineChatTool({
    name: 'create_task',
    label: 'Add task',
    access: 'write',
    permission: 'story.edit',
    description: 'Add a task under a story.',
    input: z.object({ project, number: storyNumber, title: z.string().max(200), description: z.string().max(10_000), assigneeId: z.string().nullable() }),
    execute: async (ctx, { project: key, number, title, description, assigneeId }) => {
      const t = await taskService.createTask(ctx.deps, ctx.caller, projectOf(ctx, key), number, { title, description, assigneeId })
      return { ok: true, task: { key: t.key, number: t.number, title: t.title, status: t.status } }
    },
  }),
  defineChatTool({
    name: 'update_task',
    label: 'Edit task',
    access: 'write',
    permission: 'story.edit',
    description: 'Change a task: title, description, status or assignee (null = keep; assigneeId "none" unassigns).',
    input: z.object({
      project,
      number: storyNumber,
      taskNumber: z.number().int().positive(),
      title: z.string().max(200).nullable(),
      description: z.string().max(10_000).nullable(),
      status: z.enum(TASK_STATUSES).nullable(),
      assigneeId: z.string().nullable(),
    }),
    execute: async (ctx, i) => {
      const k = projectOf(ctx, i.project)
      const tasks = await taskService.listTasks(ctx.deps.db, ctx.caller.user, k, i.number)
      const current = tasks.find((t) => t.number === i.taskNumber)
      if (!current) return { ok: false, error: `Task T${i.taskNumber} not found on story ${i.number}.` }
      const t = await taskService.updateTask(ctx.deps, ctx.caller, k, i.number, i.taskNumber, {
        version: current.version,
        ...(i.title !== null ? { title: i.title } : {}),
        ...(i.description !== null ? { description: i.description } : {}),
        ...(i.status !== null ? { status: i.status } : {}),
        ...(i.assigneeId !== null ? { assigneeId: i.assigneeId === 'none' ? null : i.assigneeId } : {}),
      })
      return { ok: true, task: { key: t.key, number: t.number, title: t.title, status: t.status, assignee: t.assignee?.displayName ?? null } }
    },
  }),
  defineChatTool({
    name: 'delete_task',
    label: 'Delete task',
    access: 'write',
    permission: 'story.edit',
    description: 'Delete a task from a story.',
    input: z.object({ project, number: storyNumber, taskNumber: z.number().int().positive() }),
    execute: async (ctx, { project: key, number, taskNumber }) => taskService.deleteTask(ctx.deps, ctx.caller, projectOf(ctx, key), number, taskNumber),
  }),
]
