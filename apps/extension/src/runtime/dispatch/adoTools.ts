// Azure Boards tools offered to the language model during an agent dispatch.
//
// Mirrors fileTools.ts: the defs are passed *inline* on each `model.sendRequest` (not registered
// globally), scoped to the @sdlc run that offers them and gated by toolGating.mapAgentToolsToAdoTools.
// Read tools (list/get) are offered whenever ADO is configured for the run; write tools (update/comment)
// are offered only when the agent declared them AND the workspace kill-switch is on. We own the
// implementations and execute the calls in the dispatcher's agentic loop, routing through adoClient.
//
// Like the file tools, failures are returned as readable *strings* — never thrown — so the model can
// read the error and recover (e.g. fix a field name and retry).

import * as vscode from 'vscode'
import {
  addWorkItemComment,
  getWorkItem,
  queryWorkItems,
  updateWorkItem,
  workItemToTaskPrompt,
  type WorkItem,
} from '../../integrations/azureDevOps/adoClient'

import { ADO_READ_TOOLS, ADO_WRITE_TOOLS, type AdoToolName, type AdoToolPermission } from './toolCatalog'

export {
  ADO_READ_TOOLS,
  ADO_WRITE_TOOLS,
  type AdoReadTool,
  type AdoToolName,
  type AdoToolPermission,
  type AdoWriteTool,
} from './toolCatalog'

/** Per-run Azure DevOps connection the tools act against. */
export interface AdoToolConfig {
  org: string
  project: string
  /** Lazily fetch a fresh bearer token (ADO scope) — called per invocation. */
  getToken: () => Promise<string>
  /** The work item the run is seeded with; used as the default `id` for get/update/comment. */
  workItemId?: number
}

const TOOL_DEFS: Record<AdoToolName, vscode.LanguageModelChatTool> = {
  list_work_items: {
    name: 'list_work_items',
    description:
      'Query Azure Boards work items. Filter by "state", "workItemType", or "assignedToMe". Returns a list of "#id [state] (type) title" lines.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Filter by state, e.g. "Active", "New", "Closed".' },
        workItemType: { type: 'string', description: 'Filter by type, e.g. "User Story", "Bug", "Task".' },
        assignedToMe: { type: 'boolean', description: 'Restrict to items assigned to the signed-in user.' },
        max: { type: 'number', description: 'Max items to return (default 50).' },
      },
    },
  },
  get_work_item: {
    name: 'get_work_item',
    description:
      'Fetch one Azure Boards work item (title, type, state, description, acceptance criteria). Omit "id" to use the work item this run is seeded with.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Work item id. Defaults to the run\'s seeded work item.' } },
    },
  },
  update_work_item: {
    name: 'update_work_item',
    description:
      'Update fields on an Azure Boards work item. "fields" keys may be: state, title, description, acceptanceCriteria, priority, storyPoints, tags. Omit "id" to target the run\'s seeded work item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Work item id. Defaults to the run\'s seeded work item.' },
        fields: { type: 'object', description: 'Map of field name → new value, e.g. { "state": "Active" }.' },
      },
      required: ['fields'],
    },
  },
  add_work_item_comment: {
    name: 'add_work_item_comment',
    description:
      'Post a discussion comment to an Azure Boards work item. Omit "id" to target the run\'s seeded work item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Work item id. Defaults to the run\'s seeded work item.' },
        text: { type: 'string', description: 'Comment body (HTML allowed).' },
      },
      required: ['text'],
    },
  },
}

type ToolInput = Record<string, unknown>

function renderWorkItemLine(wi: WorkItem): string {
  return `#${wi.id} [${wi.state}] (${wi.type}) ${wi.title}`
}

/**
 * Build the ADO tools to offer the model and an `invoke` that executes a call by name. Returns no defs
 * when `config` is undefined (ADO not configured for the run) or when permission grants nothing.
 */
export function buildAdoTools(
  perm: AdoToolPermission,
  config: AdoToolConfig | undefined,
): {
  defs: vscode.LanguageModelChatTool[]
  invoke: (name: string, input: ToolInput, token: vscode.CancellationToken) => Promise<string>
} {
  const names: AdoToolName[] = []
  if (config) {
    if (perm.read) names.push(...ADO_READ_TOOLS)
    for (const w of ADO_WRITE_TOOLS) if (perm.write.has(w)) names.push(w)
  }
  const defs = names.map((n) => TOOL_DEFS[n])

  const invoke = async (name: string, input: ToolInput, _token: vscode.CancellationToken): Promise<string> => {
    if (!config) return 'Azure DevOps is not configured for this run; board tools are unavailable.'
    if (!names.includes(name as AdoToolName)) return `Tool "${name}" is not permitted for this agent.`

    const resolveId = (): number | undefined => {
      const raw = input.id
      const id = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(id) && id > 0 ? id : config.workItemId
    }

    try {
      const token = await config.getToken()
      const { org, project } = config
      switch (name as AdoToolName) {
        case 'list_work_items': {
          const items = await queryWorkItems({
            org,
            project,
            token,
            state: typeof input.state === 'string' ? input.state : undefined,
            workItemType: typeof input.workItemType === 'string' ? input.workItemType : undefined,
            assignedToMe: Boolean(input.assignedToMe),
            max: typeof input.max === 'number' ? input.max : undefined,
          })
          if (items.length === 0) return 'No matching work items.'
          return items.map(renderWorkItemLine).join('\n')
        }
        case 'get_work_item': {
          const id = resolveId()
          if (!id) return 'No work item id supplied and the run has no seeded work item.'
          return workItemToTaskPrompt(await getWorkItem({ org, project, token, id }))
        }
        case 'update_work_item': {
          const id = resolveId()
          if (!id) return 'No work item id supplied and the run has no seeded work item.'
          const fields = (input.fields ?? {}) as Record<string, unknown>
          const updated = await updateWorkItem({ org, project, token, id, fields })
          return `Updated work item #${updated.id}. Now: [${updated.state}] ${updated.title}`
        }
        case 'add_work_item_comment': {
          const id = resolveId()
          if (!id) return 'No work item id supplied and the run has no seeded work item.'
          const text = String(input.text ?? '')
          if (!text.trim()) return 'The "text" argument is empty; nothing to post.'
          const res = await addWorkItemComment({ org, project, token, id, text })
          return `Posted comment ${res.id} to work item #${id}.`
        }
        default:
          return `Unknown tool "${name}".`
      }
    } catch (e) {
      return `Tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  return { defs, invoke }
}
