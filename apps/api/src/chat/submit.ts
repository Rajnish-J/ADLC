// Review & submit: the user turns a chat draft into the real thing. Everything goes through the same services
// (and permission checks) as the rest of the API; the assistant never creates anything itself.

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { UIMessage } from 'ai'
import {
  CreateProjectInputSchema,
  DRAFT_DATA_SCHEMAS,
  DRAFT_SUBMITTED_PART,
  type ChatDraft,
  type DraftDataByKind,
  type DraftKind,
  type DraftResult,
  type DraftSubmittedData,
} from '@sdlc/contracts'
import { workflowDraftToSpec } from '@sdlc/core'
import { chatDrafts } from '../db/chatSchema'
import { projects } from '../db/schema'
import { badRequest, conflict, HttpError, parse } from '../http'
import * as agentService from '../services/agents'
import type { Caller, ServiceDeps } from '../services/context'
import * as projectService from '../services/projects'
import { updateProject } from '../services/settings'
import * as storyService from '../services/stories'
import * as taskService from '../services/tasks'
import * as workflowService from '../services/workflows'
import { draftProblems } from './tools/drafts'
import { saveMessages, setDraftStatus, toChatDraft, type DraftRow } from './store'

async function projectKeyOf(deps: ServiceDeps, draft: DraftRow): Promise<string> {
  if (!draft.projectId) throw badRequest('This draft has no project. Pick a project in the chat and ask the assistant to save the draft again.')
  const [p] = await deps.db.select({ key: projects.key }).from(projects).where(eq(projects.id, draft.projectId)).limit(1)
  if (!p) throw badRequest('The draft’s project no longer exists.')
  return p.key
}

async function submitWorkflow(deps: ServiceDeps, caller: Caller, draft: DraftRow, data: DraftDataByKind['workflow']): Promise<DraftResult> {
  const key = await projectKeyOf(deps, draft)
  const spec = workflowDraftToSpec(data)
  if (draft.targetId) {
    const current = await workflowService.getWorkflow(deps.db, caller.user, key, draft.targetId)
    const w = await workflowService.updateWorkflow(deps, caller, key, current.id, { version: current.version, name: data.name, description: data.description, spec })
    if (data.setAsDefault && !w.isDefault) await workflowService.setDefaultWorkflow(deps, caller, key, w.id)
    return { label: `Updated workflow "${w.name}" (version ${w.version}) in ${key}`, ref: { type: 'workflow', projectKey: key, id: w.id } }
  }
  const w = await workflowService.createWorkflow(deps, caller, key, { name: data.name, description: data.description, spec, setAsDefault: data.setAsDefault })
  return {
    label: `Created workflow "${w.name}" in ${key}${w.isDefault ? ' (project default)' : ''}`,
    ref: { type: 'workflow', projectKey: key, id: w.id },
  }
}

async function submitProject(deps: ServiceDeps, caller: Caller, draft: DraftRow, data: DraftDataByKind['project']): Promise<DraftResult> {
  if (draft.targetId) {
    const p = await updateProject(deps, caller, draft.targetId, { name: data.name, description: data.description })
    return { label: `Updated project ${p.key}`, ref: { type: 'project', projectKey: p.key } }
  }
  const input = parse(CreateProjectInputSchema, {
    ...(data.key ? { key: data.key } : {}),
    name: data.name,
    description: data.description,
    ...(data.setup === 'workspace' ? { workspace: true } : {}),
    ...(data.setup === 'repository'
      ? {
          repository: {
            url: data.repositoryUrl ?? '',
            ...(data.defaultBranch ? { defaultBranch: data.defaultBranch } : {}),
            ...(data.connectionId ? { connectionId: data.connectionId } : {}),
          },
        }
      : {}),
  })
  const p = await projectService.createProject(deps, caller, input)
  return { label: `Created project ${p.key} — ${p.name}`, ref: { type: 'project', projectKey: p.key } }
}

async function submitAgent(
  deps: ServiceDeps,
  caller: Caller,
  draft: DraftRow,
  kind: 'agent' | 'skill',
  data: DraftDataByKind['agent'] | DraftDataByKind['skill'],
): Promise<DraftResult> {
  const key = await projectKeyOf(deps, draft)
  const fields =
    kind === 'agent'
      ? (() => {
          const a = data as DraftDataByKind['agent']
          return {
            name: a.name,
            description: a.description,
            category: a.category,
            sdlcStage: a.sdlcStage,
            tools: a.tools,
            model: a.model,
            minProjectRole: a.minProjectRole,
            instructions: a.instructions,
          }
        })()
      : { name: data.name, description: data.description, category: 'skill', tools: data.tools, instructions: data.instructions }
  if (draft.targetId) {
    const a = await agentService.updatePlatformAgent(deps, caller, key, draft.targetId, fields)
    return { label: `Updated ${kind} "${a.name}" in ${key}`, ref: { type: 'agent', projectKey: key, slug: a.slug, kind } }
  }
  const a = await agentService.createPlatformAgent(deps, caller, key, { ...fields, kind, slug: data.slug })
  return { label: `Created ${kind} "${a.name}" (${a.slug}) in ${key}`, ref: { type: 'agent', projectKey: key, slug: a.slug, kind } }
}

async function submitStories(deps: ServiceDeps, caller: Caller, draft: DraftRow, data: DraftDataByKind['stories']): Promise<DraftResult> {
  const key = await projectKeyOf(deps, draft)
  if (data.stories.length === 0) throw badRequest('The draft has no stories.')
  const created: number[] = []
  for (const [i, s] of data.stories.entries()) {
    try {
      const story = await storyService.createStory(deps, caller, key, {
        title: s.title,
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria.filter((c) => c.trim()),
        priority: s.priority,
        status: s.status,
        labels: s.labels,
        dueDate: s.dueDate || null,
      })
      created.push(story.number)
      for (const t of s.tasks) {
        if (t.title.trim()) await taskService.createTask(deps, caller, key, story.number, { title: t.title, description: t.description })
      }
    } catch (err) {
      if (created.length === 0 || !(err instanceof HttpError)) throw err
      // Keep what is left in the draft so the user can fix it and submit the rest.
      const rest = { stories: data.stories.slice(i) }
      await deps.db.update(chatDrafts).set({ data: rest, version: draft.version + 1, updatedAt: new Date() }).where(eq(chatDrafts.id, draft.id))
      throw conflict(
        `Created ${created.map((n) => `${key}-${n}`).join(', ')}, then "${s.title}" failed: ${err.message} The remaining stories are still in the draft.`,
      )
    }
  }
  const keys = created.map((n) => `${key}-${n}`)
  return { label: `Created ${created.length} ${created.length === 1 ? 'story' : 'stories'} in ${key}: ${keys.join(', ')}`, ref: { type: 'stories', projectKey: key, numbers: created } }
}

/** Submit an open draft as the user. Returns the submitted draft. */
export async function submitDraft(deps: ServiceDeps, caller: Caller, draft: DraftRow): Promise<ChatDraft> {
  if (draft.status !== 'open') throw conflict('This draft was already submitted or discarded.')
  const kind = draft.kind as DraftKind
  const parsed = DRAFT_DATA_SCHEMAS[kind].safeParse(draft.data)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw badRequest(`${first?.path.join('.') || 'Draft'}: ${first?.message ?? 'invalid'}`)
  }
  const problems = draftProblems(kind, parsed.data as never)
  if (problems.errors.length) throw badRequest(problems.errors.join(' '), problems.errors)

  let result: DraftResult
  switch (kind) {
    case 'workflow':
      result = await submitWorkflow(deps, caller, draft, parsed.data as DraftDataByKind['workflow'])
      break
    case 'project':
      result = await submitProject(deps, caller, draft, parsed.data as DraftDataByKind['project'])
      break
    case 'agent':
    case 'skill':
      result = await submitAgent(deps, caller, draft, kind, parsed.data as DraftDataByKind['agent'])
      break
    case 'stories':
      result = await submitStories(deps, caller, draft, parsed.data as DraftDataByKind['stories'])
      break
  }

  const row = await setDraftStatus(deps.db, draft.id, 'submitted', result)
  // A note in the thread, so both the user and the assistant see what was created.
  const note: DraftSubmittedData = { draftId: draft.id, kind, label: result.label, ref: result.ref }
  const message = { id: `sub_${randomUUID()}`, role: 'assistant', parts: [{ type: DRAFT_SUBMITTED_PART, data: note }] } as unknown as UIMessage
  await saveMessages(deps.db, draft.threadId, [message])
  return toChatDraft(deps.db, row)
}
