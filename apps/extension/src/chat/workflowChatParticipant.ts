// The `@sdlc` chat participant — the interactive front-end for running a governed workflow.
//
// Flow: the user invokes `@sdlc [workflow name]` in Copilot Chat. We resolve a saved WorkflowSpec, and if
// its start node is an *issue trigger* we fetch the user's assigned Azure DevOps work items, list them in
// the chat, and let them pick one. The picked item seeds the run; we then start the run on the RunService
// and stream each agent's work back into the same chat as it executes (live tokens via the dispatcher's
// onFragment hook). Approval nodes pause the run and prompt the user in-chat to approve/reject.
//
// Everything downstream (compile → drive → audit → Runs tree) is the existing machinery; this file only
// adds the chat surface and the issue-trigger seeding.

import { randomUUID } from 'crypto'
import * as vscode from 'vscode'
import { ARM_SCOPE } from '../foundry/constants'
import { getAccountLabel } from '../auth/azureAuth'
import { WorkflowStore } from '../runtime/workflowStore'
import type { WorkflowSpec } from '../runtime/spec'
import type { RunService } from '../runtime/runService'
import type { RunState, RunStep } from '../runtime/port'
import type { LmAgentDispatcher } from '../runtime/dispatch/lmAgentDispatcher'
import { buildAgentResolver, resolveGitContext } from '../runtime/dispatch/dispatchContext'
import { seedRunInputs } from './seedRunInputs'

export interface ChatParticipantDeps {
  runs: RunService
  /** The shared LM dispatcher; we bind this run's context (agent resolver + model + token stream) to it. */
  dispatcher: LmAgentDispatcher
}

const PARTICIPANT_ID = 'sdlc-governance.workflow'

/** Register `@sdlc`. Returns the participant disposable (pushed to context.subscriptions by the caller). */
export function registerWorkflowChatParticipant(deps: ChatParticipantDeps): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    return runWorkflowTurn(deps, request, stream, token)
  }
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler)
  return participant
}

async function runWorkflowTurn(
  deps: ChatParticipantDeps,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const store = WorkflowStore.forActiveWorkspace()
  if (!store) {
    stream.markdown('⚠️ Open a workspace folder first — workflows are stored in `.sdlc/workflows`.')
    return
  }

  // 1) Resolve the target workflow (named in the prompt, else let the user pick).
  const spec = await resolveWorkflow(store, request.prompt.trim(), stream)
  if (!spec) return
  stream.markdown(`### ▶ ${spec.name}\n${spec.description || ''}\n\n`)

  // 2) Seed inputs — from an issue trigger (ADO) or free text.
  const trigger = spec.nodes.find((n) => n.kind === 'trigger')
  const seeded = await seedRunInputs(
    trigger,
    {
      progress: (m) => stream.progress(m),
      info: (m) => stream.markdown(`\n${m}\n`),
      askTask: async () => {
        const p = request.prompt.trim()
        const task =
          p.replace(/^run\s+\S+\s*/i, '').trim() ||
          (await vscode.window.showInputBox({ prompt: 'Describe the task to seed the workflow' })) ||
          ''
        return task || undefined
      },
      pickWorkItem: async (items) => {
        stream.markdown(`Found **${items.length}** item(s) assigned to you:\n\n`)
        for (const wi of items) {
          stream.markdown(`- **#${wi.id}** [${wi.state}] [${wi.title}](${wi.url})\n`)
        }
        const picked = await vscode.window.showQuickPick(
          items.map((wi) => ({
            label: `#${wi.id} · ${wi.title}`,
            description: wi.state,
            detail: wi.description.slice(0, 120),
            wi,
          })),
          { placeHolder: 'Pick the work item to run this workflow against', matchOnDetail: true },
        )
        if (picked) stream.markdown(`\n▶ Running against **#${picked.wi.id} — ${picked.wi.title}**\n\n`)
        return picked?.wi
      },
    },
    token,
  )
  if (!seeded) return
  const { ado, ...inputs } = seeded

  // 2b) Resolve git repository context, independent of trigger type — a manually-triggered workflow
  // can still commit/push/PR just as well as an issue-triggered one.
  const git = await resolveGitContext(typeof inputs.workItemId === 'number' ? inputs.workItemId : undefined)

  // 3) Ensure a language model is available before doing any work. The chat normally hands us an
  // authorized model (request.model); if not, try selecting a Copilot model directly. If both fail,
  // Copilot Chat is missing/signed-out — give actionable guidance instead of an obscure failure.
  let model = request.model
  if (!model) {
    model = (await vscode.lm.selectChatModels({ vendor: 'copilot' }))[0]
  }
  if (!model) {
    // Any provider, not just Copilot — lets the governed run use another registered vscode.lm model.
    model = (await vscode.lm.selectChatModels())[0]
  }
  if (!model) {
    stream.markdown(
      '⚠️ **No language model available.** This workflow runs its agents through a language model, ' +
        'which is supplied by **GitHub Copilot Chat**.\n\n' +
        '- Install the **GitHub Copilot Chat** extension and **sign in** to GitHub.\n' +
        '- Make sure Copilot is enabled for this workspace.\n' +
        '- Offline or testing? Set `sdlcGovernance.dispatch.mode` to `"mock"` to use the deterministic stub.\n',
    )
    return
  }

  // 4) Build the agent resolver from discovery (+ Foundry agents) and bind it to THIS run only — chosen
  // run id, bound before the run starts (it drives synchronously inside startRun), so a canvas run started
  // meanwhile never picks up this chat's model, token or stream.
  const resolve = await buildAgentResolver({ token, foundry: 'always' })
  const runId = `chat-run-${randomUUID()}`
  const binding = deps.dispatcher.bindRun(runId, {
    resolve,
    onFragment: (_agent, fragment) => stream.markdown(fragment),
    // The resolved, authorized model and the chat handler's cancellation token.
    model,
    token,
    // Connect the run to Azure Boards (issue trigger only) so agents can fetch/update the work item.
    ado,
    // Connect the run to the workspace's git repo (+ Azure DevOps, if resolved) so agents can commit,
    // push, and open Pull Requests.
    git,
  })

  const announced = new Set<string>()
  const sub = deps.runs.onDidChangeRun((state) => renderStep(state, announced, stream))

  try {
    const actor = (await getAccountLabel(ARM_SCOPE)) ?? 'local-user'
    stream.progress('Starting governed run…')
    let state = await deps.runs.startRun(spec, actor, inputs, { runId })

    // 5) Drive approvals in-chat: pause → prompt → resume, until the run settles.
    while (state.status === 'awaiting_approval' && state.pendingApproval && !token.isCancellationRequested) {
      const q = state.pendingApproval.question
      const choice = await vscode.window.showInformationMessage(q, { modal: true }, 'Approve', 'Reject')
      if (choice === 'Approve') {
        stream.markdown(`\n\n✅ **Approved** — continuing.\n\n`)
        state = await deps.runs.approve(state.runId, actor)
      } else {
        stream.markdown(`\n\n⛔ **Rejected** — stopping the run.\n\n`)
        state = await deps.runs.reject(state.runId, actor, choice === undefined ? 'No response' : undefined)
        break
      }
    }

    renderSummary(state, stream)
  } catch (err) {
    stream.markdown(`\n\n❌ Run failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    sub.dispose()
    binding.dispose()
  }
}

/** Resolve a workflow by name from the prompt; otherwise list saved workflows as picker buttons. */
async function resolveWorkflow(
  store: WorkflowStore,
  prompt: string,
  stream: vscode.ChatResponseStream,
): Promise<WorkflowSpec | undefined> {
  const entries = await store.listAll()
  // Strip a leading "run " verb if present.
  const query = prompt.replace(/^run\s+/i, '').trim().toLowerCase()

  if (query) {
    const match = entries.find(
      (e) => e.name.toLowerCase() === query || e.id.toLowerCase() === query,
    )
    if (match) {
      const found = await store.loadById(match.id)
      if (found) return found
    }
  }

  if (entries.length === 0) {
    stream.markdown('No workflows found. Create one in the Workflow Builder first.')
    return undefined
  }

  const picked = await vscode.window.showQuickPick(
    entries.map((e) => ({ label: e.name, description: e.isDefault ? 'SDLC default' : e.id, id: e.id })),
    { placeHolder: 'Which workflow do you want to run?' },
  )
  if (!picked) {
    stream.markdown('No workflow selected.')
    return undefined
  }
  return store.loadById(picked.id)
}

/** Print a header for each newly-seen step so the chat reads as a transcript of the run. */
function renderStep(state: RunState, announced: Set<string>, stream: vscode.ChatResponseStream): void {
  for (const step of state.steps) {
    if (announced.has(step.id)) continue
    if (step.status === 'running') {
      announced.add(step.id)
      stream.markdown(`\n\n#### ${stepIcon(step)} ${step.label}\n`)
      if (step.kind !== 'agent') {
        // Non-agent steps don't stream tokens; their output is shown on completion via summary.
      }
    }
  }
}

function stepIcon(step: RunStep): string {
  switch (step.kind) {
    case 'agent':
      return '🤖'
    case 'gate':
      return '⛨'
    case 'approval':
      return '☑'
    default:
      return '•'
  }
}

function renderSummary(state: RunState, stream: vscode.ChatResponseStream): void {
  const verb =
    state.status === 'completed'
      ? '✅ Completed'
      : state.status === 'failed'
        ? '❌ Failed'
        : state.status === 'cancelled'
          ? '⏹ Cancelled'
          : state.status
  stream.markdown(`\n\n---\n**${verb}** — run \`${state.runId}\` (${state.steps.length} step(s)).`)
  if (state.error) stream.markdown(`\n\n> ${state.error}`)
  stream.button({
    command: 'sdlcGovernance.openRunAudit',
    title: 'Open run audit log',
  })
}
