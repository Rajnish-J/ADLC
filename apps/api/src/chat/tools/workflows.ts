// Workflows: read them, load one into the draft for editing, and the direct changes (map an agent or skills onto
// a step, make default, delete). Creating or reshaping a workflow goes through the draft → Review & submit.

import { z } from 'zod'
import { specToWorkflowDraft } from '@sdlc/core'
import { loadProjectAccess } from '../../access'
import { setStepSkills } from '../../services/stepSkills'
import * as workflowService from '../../services/workflows'
import { upsertDraft } from '../store'
import { defineChatTool, projectOf, PROJECT_FIELD_DESCRIPTION } from './kit'

const project = z.string().nullable().describe(PROJECT_FIELD_DESCRIPTION)
const workflowId = z.string().describe('Workflow id (from list_workflows).')

export const workflowTools = [
  defineChatTool({
    name: 'list_workflows',
    label: 'List workflows',
    access: 'read',
    description: "A project's workflows: id, name, description, whether it is the default, and version.",
    input: z.object({ project }),
    execute: async (ctx, { project: key }) => workflowService.listWorkflows(ctx.deps.db, ctx.caller.user, projectOf(ctx, key)),
  }),
  defineChatTool({
    name: 'get_workflow',
    label: 'Read workflow',
    access: 'read',
    description: 'One workflow with its steps in order: id, kind, label, mapped agent and skills, approval questions.',
    input: z.object({ project, workflowId }),
    execute: async (ctx, { project: key, workflowId: id }) => {
      const w = await workflowService.getWorkflow(ctx.deps.db, ctx.caller.user, projectOf(ctx, key), id)
      const linear = specToWorkflowDraft(w.spec, w.isDefault)
      return {
        id: w.id,
        name: w.name,
        description: w.description,
        isDefault: w.isDefault,
        version: w.version,
        steps: w.spec.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
          ...(n.data.agentId ? { agent: n.data.agentId } : {}),
          ...(n.data.skills?.length ? { skills: n.data.skills } : {}),
          ...(n.data.question ? { question: n.data.question } : {}),
          ...(n.data.sdlcStep ? { sdlcStep: n.data.sdlcStep } : {}),
        })),
        edges: w.spec.edges,
        editableInChat: linear.ok ? true : linear.reason,
      }
    },
  }),
  defineChatTool({
    name: 'load_workflow_into_draft',
    label: 'Edit workflow (draft)',
    access: 'read',
    kind: 'draft',
    description:
      'Start editing an existing workflow: copies it into the draft (replacing any open workflow draft). Then change it with update_draft; the user saves it with Review & submit. Set asCopy to start a NEW workflow from it instead.',
    input: z.object({ project, workflowId, asCopy: z.boolean().describe('true = a new workflow based on this one; false = edit this one.') }),
    execute: async (ctx, { project: key, workflowId: id, asCopy }) => {
      const k = projectOf(ctx, key)
      const access = await loadProjectAccess(ctx.deps.db, ctx.caller.user, k)
      const w = await workflowService.getWorkflow(ctx.deps.db, ctx.caller.user, k, id)
      const linear = specToWorkflowDraft(w.spec, w.isDefault)
      if (!linear.ok) return { ok: false, error: `"${w.name}" can't be edited in chat: ${linear.reason} Use the Workflow page for it.` }
      const data = asCopy ? { ...linear.draft, name: `${w.name} (copy)`, setAsDefault: false } : linear.draft
      const draft = await upsertDraft(ctx.deps.db, {
        threadId: ctx.threadId,
        kind: 'workflow',
        projectId: access.project.id,
        data,
        openQuestions: [],
        ready: false,
        target: asCopy ? null : { id: w.id, label: w.name },
        replace: true,
      })
      return { ok: true, draftId: draft.id, mode: asCopy ? 'create (copy)' : `editing "${w.name}"`, data }
    },
  }),
  defineChatTool({
    name: 'set_step_agent',
    label: 'Map agent to step',
    access: 'write',
    permission: 'workflow.edit',
    description: 'Map an agent (slug from list_agents) onto one agent step of a workflow, or unmap it with null.',
    input: z.object({ project, workflowId, stepId: z.string(), agentSlug: z.string().nullable() }),
    execute: async (ctx, { project: key, workflowId: id, stepId, agentSlug }) =>
      workflowService.setStepAgent(ctx.deps, ctx.caller, projectOf(ctx, key), id, stepId, { agentSlug }),
  }),
  defineChatTool({
    name: 'set_step_skills',
    label: 'Set step skills',
    access: 'write',
    permission: 'workflow.edit',
    description: 'Set the skills (slugs from list_skills) an agent step may load. Replaces the current list; [] clears it.',
    input: z.object({ project, workflowId, stepId: z.string(), skills: z.array(z.string()).max(20) }),
    execute: async (ctx, { project: key, workflowId: id, stepId, skills }) =>
      setStepSkills(ctx.deps, ctx.caller, projectOf(ctx, key), id, stepId, { skills }),
  }),
  defineChatTool({
    name: 'set_default_workflow',
    label: 'Make workflow default',
    access: 'write',
    permission: 'workflow.edit',
    description: "Make a workflow the project's default (the one Start uses unless another is picked).",
    input: z.object({ project, workflowId }),
    execute: async (ctx, { project: key, workflowId: id }) => workflowService.setDefaultWorkflow(ctx.deps, ctx.caller, projectOf(ctx, key), id),
  }),
  defineChatTool({
    name: 'delete_workflow',
    label: 'Delete workflow',
    access: 'write',
    permission: 'workflow.edit',
    description: 'Delete a workflow. Refused for the default workflow or while runs of it are in progress. Past runs keep their history.',
    input: z.object({ project, workflowId }),
    execute: async (ctx, { project: key, workflowId: id }) => workflowService.deleteWorkflow(ctx.deps, ctx.caller, projectOf(ctx, key), id),
  }),
]
