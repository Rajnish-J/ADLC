// Claude Code hand-off seeding.
//
// The `@sdlc` Copilot path drives the governed node graph itself. The Claude Code extension exposes
// no model/API we can drive, so for that assistant we do the next best thing: run the same input
// seeding (resolve the workflow, and for an issue trigger fetch + pick an Azure Boards work item),
// then compile the workflow's ordered agent steps + their instructions into ONE rich prompt that
// Claude Code carries out as a single agent. The prompt is handed over via the clipboard by the
// caller (extension.ts).
//
// This reuses the same building blocks as the chat participant (WorkflowStore, adoClient, discovery)
// but talks to the user through window QuickPicks/messages instead of a chat stream.

import * as vscode from 'vscode'
import { getToken } from '../auth/azureAuth'
import { discover } from '../discovery/normalizer'
import type { InternalAgent } from '../discovery/agentModel'
import { listFoundryAgents, toInternalAgentLike } from '../foundry/foundryAgents'
import { WorkflowStore } from '../runtime/workflowStore'
import type { SpecNode, WorkflowSpec } from '../runtime/spec'
import { seedRunInputs } from './seedRunInputs'

/**
 * Resolve, seed, and compile a Claude Code prompt for `workflowArg`. Returns the prompt text, or
 * `undefined` if the user cancelled at any picker or seeding wasn't possible (a message is shown).
 */
export async function prepareClaudeCodePrompt(
  workflowArg: string,
  token?: vscode.CancellationToken,
): Promise<string | undefined> {
  const store = WorkflowStore.forActiveWorkspace()
  if (!store) {
    vscode.window.showWarningMessage('Open a workspace folder first — workflows are stored in `.sdlc/workflows`.')
    return undefined
  }

  const spec = await resolveWorkflowByName(store, workflowArg)
  if (!spec) return undefined

  const inputs = await seedWorkflowInputs(spec, workflowArg, token)
  if (!inputs) return undefined

  // Resolve agent instructions (discovery + Foundry). Both are best-effort: a missing agent just
  // yields a placeholder line in the prompt rather than aborting the hand-off.
  const byId = new Map<string, InternalAgent>()
  try {
    const result = await discover(token)
    for (const a of result.agents) byId.set(a.id, a)
  } catch {
    /* discovery best-effort */
  }
  try {
    for (const fa of await listFoundryAgents(getToken)) byId.set(fa.id, toInternalAgentLike(fa))
  } catch {
    /* foundry best-effort */
  }

  return buildClaudeCodePrompt(spec, inputs.task, byId, {
    workItemId: inputs.workItemId,
    workItemUrl: inputs.workItemUrl,
  })
}

/** Match a saved workflow by name/id from the prompt; otherwise let the user pick from a QuickPick. */
async function resolveWorkflowByName(store: WorkflowStore, query: string): Promise<WorkflowSpec | undefined> {
  const entries = await store.listAll()
  const q = query.replace(/^run\s+/i, '').trim().toLowerCase()
  if (q) {
    const match = entries.find((e) => e.name.toLowerCase() === q || e.id.toLowerCase() === q)
    if (match) {
      const found = await store.loadById(match.id)
      if (found) return found
    }
  }
  if (entries.length === 0) {
    vscode.window.showWarningMessage('No workflows found. Create one in the Workflow Builder first.')
    return undefined
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((e) => ({ label: e.name, description: e.isDefault ? 'SDLC default' : e.id, id: e.id })),
    { placeHolder: 'Which workflow do you want to run?' },
  )
  return picked ? store.loadById(picked.id) : undefined
}

/** Seed the run task — issue trigger fetches + picks an ADO work item; otherwise free-text. */
async function seedWorkflowInputs(
  spec: WorkflowSpec,
  query: string,
  token?: vscode.CancellationToken,
): Promise<{ task: string; workItemId?: number; workItemUrl?: string } | undefined> {
  const trigger = spec.nodes.find((n) => n.kind === 'trigger')
  const seeded = await seedRunInputs(
    trigger,
    {
      progress: (m) => void vscode.window.setStatusBarMessage(m, 4000),
      info: (m) => void vscode.window.showWarningMessage(m),
      askTask: async () =>
        query.replace(/^run\s+\S+\s*/i, '').trim() ||
        (await vscode.window.showInputBox({ prompt: 'Describe the task to seed the workflow' })) ||
        undefined,
      pickWorkItem: async (items) => {
        const picked = await vscode.window.showQuickPick(
          items.map((wi) => ({
            label: `#${wi.id} · ${wi.title}`,
            description: wi.state,
            detail: wi.description.slice(0, 120),
            wi,
          })),
          { placeHolder: 'Pick the work item to run this workflow against', matchOnDetail: true },
        )
        return picked?.wi
      },
    },
    token,
  )
  if (!seeded || typeof seeded.task !== 'string') return undefined
  return {
    task: seeded.task,
    workItemId: seeded.workItemId as number | undefined,
    workItemUrl: seeded.workItemUrl as string | undefined,
  }
}

/** Visit nodes in execution order: BFS from the trigger over the spec edges. */
function orderedNodes(spec: WorkflowSpec): SpecNode[] {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]))
  const adj = new Map<string, string[]>()
  for (const e of spec.edges) {
    const list = adj.get(e.source) ?? []
    list.push(e.target)
    adj.set(e.source, list)
  }
  const hasIncoming = new Set(spec.edges.map((e) => e.target))
  const start =
    spec.nodes.find((n) => n.kind === 'trigger') ?? spec.nodes.find((n) => !hasIncoming.has(n.id)) ?? spec.nodes[0]

  const ordered: SpecNode[] = []
  const seen = new Set<string>()
  const queue: string[] = start ? [start.id] : []
  while (queue.length) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node) ordered.push(node)
    for (const t of adj.get(id) ?? []) if (!seen.has(t)) queue.push(t)
  }
  // Append any nodes unreachable from the trigger, in declaration order.
  for (const n of spec.nodes) if (!seen.has(n.id)) ordered.push(n)
  return ordered
}

/** Compile the workflow into a single, ordered, self-contained prompt for Claude Code. */
export function buildClaudeCodePrompt(
  spec: WorkflowSpec,
  task: string,
  byId: Map<string, InternalAgent>,
  workItem?: { workItemId?: number; workItemUrl?: string },
): string {
  const lines: string[] = [`# SDLC Workflow: ${spec.name}`]
  if (spec.description) lines.push(spec.description)
  lines.push(
    '\nYou are the **SDLC orchestrator** for a governed workflow. Work through the steps below ' +
      '**in order**. For each agent step, act as (or delegate to) the named agent: follow that ' +
      "agent's instructions, make the necessary changes in this codebase, and carry its output " +
      'forward as context for the next step. Honor the quality gates, and pause for the user ' +
      'where an approval step is noted.\n',
  )

  const wiId = workItem?.workItemId
  const wiUrl = workItem?.workItemUrl
  if (wiId || wiUrl) {
    const meta = [wiId ? `Work item: #${wiId}` : '', wiUrl ? `Source: ${wiUrl}` : ''].filter(Boolean).join('\n')
    lines.push(`## Work Item\n${meta}\n`)
    lines.push(
      'You may use the Azure DevOps helper scripts in `.claude/scripts/devops/` (e.g. ' +
        '`get-work-item.ts`, `update-work-item.ts`, `add-work-item-comment.ts`, run with `bun run`), ' +
        'or an Azure DevOps MCP server if one is configured, to fetch the latest state of this work ' +
        'item and to post progress/results back to the board.\n',
    )
  }

  lines.push(`## Task\n${task}\n`)
  lines.push('## Steps')

  let n = 1
  for (const node of orderedNodes(spec)) {
    if (node.kind === 'agent') {
      const agent = node.data.agentId ? byId.get(node.data.agentId) : undefined
      const name = agent?.name ?? node.data.agentName ?? node.label
      lines.push(`\n### Step ${n++}: ${name} (agent)`)
      const instr = agent?.instructions?.trim()
      lines.push(instr || '_(no instructions found for this agent — use your best judgment for this step)_')
    } else if (node.kind === 'gate') {
      lines.push(`\n### Step ${n++}: Quality gate — ${node.data.gateStep ?? 'review'}`)
      lines.push('Verify the work so far meets the quality bar for this step before continuing.')
    } else if (node.kind === 'approval') {
      lines.push(`\n### Step ${n++}: Approval — ${node.data.question ?? 'Approve to continue?'}`)
      lines.push('Pause and ask the user to confirm before proceeding.')
    }
  }

  lines.push('\n---\nWhen finished, summarize the changes you made and list any follow-ups.')
  return lines.join('\n')
}
