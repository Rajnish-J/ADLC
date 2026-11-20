// The draft tool (`update_draft`, one schema per draft kind), the two interaction tools the user answers in the
// UI (`ask_user`, `handoff`), and the portfolio overview.

import { z } from 'zod'
import {
  ASK_USER_TOOL,
  AskUserInputSchema,
  DRAFT_DATA_SCHEMAS,
  DRAFT_KIND_LABELS,
  HANDOFF_TOOL,
  HandoffInputSchema,
  PROJECT_KEY_PATTERN,
  UPDATE_DRAFT_TOOL,
  type DraftDataByKind,
  type DraftKind,
} from '@sdlc/contracts'
import { validateWorkflowSpec, workflowDraftToSpec } from '@sdlc/core'
import { loadProjectAccess } from '../../access'
import { portfolio } from '../../services/portfolio'
import { upsertDraft } from '../store'
import { defineChatTool, projectOf, type ChatToolDef } from './kit'

const SLUG = /^[a-z0-9][a-z0-9-]*$/

/** What submit would refuse — returned to the assistant on every save so it fixes problems early. */
export function draftProblems<K extends DraftKind>(kind: K, data: DraftDataByKind[K]): { errors: string[]; warnings: string[] } {
  switch (kind) {
    case 'workflow': {
      const d = data as DraftDataByKind['workflow']
      const { errors, warnings } = validateWorkflowSpec(workflowDraftToSpec(d))
      if (d.steps.length === 0) warnings.push('The workflow has no steps yet.')
      return { errors, warnings }
    }
    case 'project': {
      const d = data as DraftDataByKind['project']
      const errors: string[] = []
      if (!d.name.trim()) errors.push('The project needs a name.')
      if (d.key && !PROJECT_KEY_PATTERN.test(d.key.toUpperCase())) errors.push('Key: 2–10 letters or digits, starting with a letter.')
      if (d.setup === 'repository' && !d.repositoryUrl) errors.push('Importing needs a repository URL.')
      return { errors, warnings: [] }
    }
    case 'agent':
    case 'skill': {
      const d = data as DraftDataByKind['agent'] | DraftDataByKind['skill']
      const errors: string[] = []
      if (!d.name.trim()) errors.push('It needs a name.')
      if (!SLUG.test(d.slug) || d.slug.length < 2) errors.push('Slug: lowercase letters, digits and hyphens (e.g. "security-reviewer").')
      if (!d.description.trim()) errors.push('It needs a one-line description.')
      if (!d.instructions.trim()) errors.push('It needs instructions.')
      return { errors, warnings: d.tools.length === 0 ? ['No tools are allowed yet.'] : [] }
    }
    case 'stories': {
      const d = data as DraftDataByKind['stories']
      const errors = d.stories.flatMap((s, i) => [
        ...(!s.title.trim() ? [`Story ${i + 1} needs a title.`] : []),
        ...(s.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(s.dueDate) ? [`Story ${i + 1}: due date must be YYYY-MM-DD.`] : []),
      ])
      return { errors, warnings: d.stories.length === 0 ? ['No stories yet.'] : [] }
    }
  }
  return { errors: [], warnings: [] }
}

export function updateDraftTool(kind: DraftKind): ChatToolDef {
  const noun = DRAFT_KIND_LABELS[kind].noun
  return defineChatTool({
    name: UPDATE_DRAFT_TOOL,
    label: `Update ${noun} draft`,
    access: 'read',
    kind: 'draft',
    description:
      `Save your current version of the ${noun} draft. Call it on EVERY turn before replying — even on the first turn with ` +
      'details still missing — so the Review screen is always current. Send the complete draft each time. ' +
      'You never create anything yourself: the user checks the draft and clicks Review & submit. The result lists problems ' +
      'that would block submitting — fix them or ask the user.',
    input: z.object({
      data: DRAFT_DATA_SCHEMAS[kind],
      openQuestions: z.array(z.string()).describe('Exactly the questions you are asking this turn; empty when nothing is missing.'),
      ready: z.boolean().describe('True only when it could be submitted as is (no blocking problems, nothing important unknown).'),
    }),
    execute: async (ctx, input) => {
      const projectId = kind === 'project' ? null : (await loadProjectAccess(ctx.deps.db, ctx.caller.user, projectOf(ctx, null))).project.id
      const problems = draftProblems(kind, input.data as never)
      const row = await upsertDraft(ctx.deps.db, {
        threadId: ctx.threadId,
        kind,
        projectId,
        data: input.data,
        openQuestions: input.openQuestions,
        ready: input.ready && problems.errors.length === 0,
      })
      return {
        ok: true,
        saved: true,
        mode: row.targetId ? `editing "${row.targetLabel}"` : 'create',
        ready: row.ready,
        ...problems,
      }
    },
  })
}

export const askUserTool = defineChatTool({
  name: ASK_USER_TOOL,
  label: 'Ask you',
  access: 'read',
  kind: 'interaction',
  description:
    'Ask the user one or more questions and WAIT for the answers. Use it instead of writing questions in your reply whenever you ' +
    'need something only the user knows. Give each question a few concrete options and your recommended one as defaultValue ' +
    '(empty options only for genuinely free text — the card already has a free-text box, so never add "Other"). Ask everything ' +
    'you need in ONE call. The result is { answers: [{ id, question, answer }], skipped }; skipped = proceed with your defaults.',
  input: AskUserInputSchema,
})

export const handoffTool = defineChatTool({
  name: HANDOFF_TOOL,
  label: 'Hand off to a specialist',
  access: 'read',
  kind: 'interaction',
  description:
    'Offer to continue with a specialist assistant when the user wants to CREATE something (a workflow, project, agent, skill or ' +
    'stories) or needs a specialist\'s tools. The user sees a card and switches with one click; `brief` becomes their first message.',
  input: HandoffInputSchema,
})

export const portfolioTool = defineChatTool({
  name: 'portfolio_summary',
  label: 'Portfolio overview',
  access: 'read',
  description:
    'Every project the user can see: story counts by status, blocked, overdue, ready-but-unassigned, and runs in progress. Start here for cross-project questions.',
  input: z.object({}),
  execute: async (ctx) => portfolio(ctx.deps.db, ctx.caller.user),
})
