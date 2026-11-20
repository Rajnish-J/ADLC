// Phase 4 — run lifecycle commands: start a governed run, approve/reject a paused run, cancel, open the
// run-audit log. The start command discovers agents, lets the user pick + order them, compiles a WorkflowSpec
// (sequential MVP, with a gate per SDLC step; every agent is mandatory human-in-the-loop), and starts a run
// on the RunService. Concurrent / group-chat patterns are deferred (P4.5) — surfaced to the user, not
// silently absent.
//
// Signed in to the SDLC platform, "Run Workflow" first offers the project's workflows, which run in the user's
// selected harness (session/harnessStart.ts) — the same as starting from the web. Composing a chain from local
// agents runs on the built-in runtime.

import * as vscode from 'vscode'
import { ARM_SCOPE } from '../foundry/constants'
import { getAccountLabel } from '../auth/azureAuth'
import { discover } from '../discovery/normalizer'
import { SDLC_STEPS, type SdlcStep } from '../eval/sdlcSteps'
import { internalAgentToSpec } from '../runtime/compile/internalAgentToSpec'
import type { RunService } from '../runtime/runService'
import type { RunAuditStore } from '../runtime/runAudit'
import { RunNode } from '../views/runsProvider'
import type { RunState } from '../runtime/port'
import type { WorkflowSpec } from '../runtime/spec'
import { WorkflowStore } from '../runtime/workflowStore'
import { WorkflowCanvasPanel, type PanelDeps } from '../webview/workflowCanvasPanel'
import { platformHandle } from '../platform/platformAccess'
import { pickProject, startProjectWorkflow } from '../platform/session/harnessStart'

/**
 * Signed in: pick a project workflow and run it in the selected harness ('handled'), or choose to compose from local
 * agents ('compose'). Signed out: offer sign-in, or the built-in runtime ('compose'). Undefined = cancelled.
 */
async function startInHarnessFirst(): Promise<'handled' | 'compose' | undefined> {
  const client = platformHandle()?.client()
  if (!client) {
    const go = await vscode.window.showInformationMessage(
      'Sign in to the SDLC platform to run workflows in your harness (Copilot, Claude Code, Codex…).',
      { detail: 'Without signing in, you can compose a workflow from local agents and run it on the built-in runtime.' },
      'Sign In',
      'Use Built-in Runtime',
    )
    if (go === 'Sign In') await vscode.commands.executeCommand('sdlcGovernance.platform.connect')
    return go === 'Use Built-in Runtime' ? 'compose' : undefined
  }
  const project = await pickProject(client)
  if (!project) return undefined
  const workflows = await client.workflows(project.key)
  type Item = vscode.QuickPickItem & { id?: string; compose?: boolean }
  const picked = await vscode.window.showQuickPick<Item>(
    [
      ...workflows.map((w): Item => ({ label: `$(type-hierarchy-sub) ${w.name}`, description: `${w.isDefault ? 'default · ' : ''}v${w.version}`, detail: w.description || undefined, id: w.id })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(gear) Compose from local agents…', description: 'Built-in runtime', compose: true },
    ],
    { title: `Run a ${project.key} workflow`, placeHolder: 'Project workflows run on a story in your selected harness' },
  )
  if (!picked) return undefined
  if (picked.compose || !picked.id) return 'compose'
  const name = workflows.find((w) => w.id === picked.id)?.name ?? 'workflow'
  await startProjectWorkflow(client, { project, workflowId: picked.id, workflowName: name })
  return 'handled'
}

interface RunCommandDeps {
  runs: RunService
  audit: RunAuditStore
  /** Extension root, for resolving the canvas webview bundle. */
  extensionUri: vscode.Uri
  /** Reveal the Runs view after starting a run. */
  reveal: () => void
}

async function currentActor(): Promise<string> {
  return (await getAccountLabel(ARM_SCOPE)) ?? 'local-user'
}

/** Resolve the run a command targets — from the clicked tree node, else a QuickPick over matching runs. */
async function pickRun(
  runs: RunService,
  node: RunNode | undefined,
  predicate: (r: RunState) => boolean,
  placeHolder: string,
): Promise<RunState | undefined> {
  if (node?.run) return node.run
  const candidates = runs.list().filter(predicate)
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage('No matching runs.')
    return undefined
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((r) => ({ label: r.workflowName, description: `${r.status} · ${r.runId}`, run: r })),
    { placeHolder },
  )
  return picked?.run
}

export function registerRunCommands(context: vscode.ExtensionContext, deps: RunCommandDeps): void {
  const { runs, audit, reveal, extensionUri } = deps

  context.subscriptions.push(
    vscode.commands.registerCommand('sdlcGovernance.runWorkflow', async () => {
      if ((await startInHarnessFirst()) !== 'compose') return
      const result = await discover()
      const valid = result.agents.filter((a) => a.status !== 'skipped')
      if (valid.length === 0) {
        void vscode.window.showWarningMessage('No usable agents discovered to compose a workflow.')
        return
      }

      const picks = await vscode.window.showQuickPick(
        valid.map((a) => ({ label: a.name, description: a.description, agent: a, picked: true })),
        { canPickMany: true, placeHolder: 'Select agents to chain (top-to-bottom order)' },
      )
      if (!picks || picks.length === 0) return

      const task = await vscode.window.showInputBox({
        prompt: 'Task description to seed the first agent',
        value: 'Describe the SDLC task…',
      })
      if (task === undefined) return

      const agents = picks.map((p) => p.agent)
      const spec = internalAgentToSpec(agents, {
        name: `workflow-${agents.map((a) => a.name).join('-').slice(0, 40)}`,
        description: `Sequential governed run of ${agents.length} agent(s).`,
        pattern: 'sequential',
        stepForAgent: (_a, i): SdlcStep => SDLC_STEPS[Math.min(i, SDLC_STEPS.length - 1)],
      })

      // Persist the compiled spec so the canvas (and a future Foundry compiler) has a durable,
      // version-controllable source of truth to render. Best-effort: a run still proceeds if the
      // workspace is unwritable.
      const store = WorkflowStore.forActiveWorkspace()
      if (store) {
        try {
          await store.save(spec)
        } catch (err) {
          void vscode.window.showWarningMessage(
            `Could not save workflow spec: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      const actor = await currentActor()
      const state = await runs.startRun(spec, actor, { task })
      WorkflowCanvasPanel.render({ extensionUri, runService: runs }, spec, state)
      reveal()
      const verb =
        state.status === 'awaiting_approval'
          ? 'paused for approval'
          : state.status === 'completed'
            ? 'completed'
            : state.status
      void vscode.window.showInformationMessage(`Run ${verb}: ${state.workflowName} (${state.runId}).`)
    }),

    vscode.commands.registerCommand('sdlcGovernance.approveRun', async (node?: RunNode) => {
      const run = await pickRun(runs, node, (r) => r.status === 'awaiting_approval', 'Approve which run?')
      if (!run) return
      const comment = await vscode.window.showInputBox({ prompt: 'Approval comment (optional)' })
      const actor = await currentActor()
      await runs.approve(run.runId, actor, comment || undefined)
    }),

    vscode.commands.registerCommand('sdlcGovernance.rejectRun', async (node?: RunNode) => {
      const run = await pickRun(runs, node, (r) => r.status === 'awaiting_approval', 'Reject which run?')
      if (!run) return
      const comment = await vscode.window.showInputBox({ prompt: 'Reason for rejection (optional)' })
      const actor = await currentActor()
      await runs.reject(run.runId, actor, comment || undefined)
    }),

    vscode.commands.registerCommand('sdlcGovernance.cancelRun', async (node?: RunNode) => {
      const run = await pickRun(
        runs,
        node,
        (r) => ['queued', 'running', 'awaiting_approval'].includes(r.status),
        'Cancel which run?',
      )
      if (!run) return
      await runs.cancel(run.runId)
    }),

    vscode.commands.registerCommand('sdlcGovernance.openRunAudit', async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(audit.uri)
        await vscode.window.showTextDocument(doc)
      } catch {
        void vscode.window.showInformationMessage('No run audit log yet — start a run first.')
      }
    }),

    // Phase 5A — open the read-mostly canvas. Three entry points:
    //   • from a Runs tree node  → live overlay of that run
    //   • from a .sdlc/workflows/*.json editor/explorer item → static spec view
    //   • from the palette (no arg) → pick a run, else a saved workflow file
    vscode.commands.registerCommand('sdlcGovernance.openCanvas', async (arg?: RunNode | vscode.Uri) => {
      if (arg instanceof RunNode) {
        await openCanvasForRun(extensionUri, runs, arg.run)
        return
      }
      if (arg instanceof vscode.Uri) {
        await openCanvasForFile(extensionUri, runs, arg)
        return
      }
      await openCanvasViaPicker(extensionUri, runs)
    }),
  )
}

/**
 * Resolve a run's spec — the one it was started with (project workflows come from the platform, not the store),
 * else the workspace workflow saved under its name — and open the canvas with live overlay.
 */
async function openCanvasForRun(
  extensionUri: vscode.Uri,
  runs: RunService,
  run: RunState,
): Promise<void> {
  const spec = runs.specOf(run.runId) ?? (await WorkflowStore.forActiveWorkspace()?.loadByName(run.workflowName))
  if (!spec) {
    void vscode.window.showWarningMessage(
      `No saved spec found for "${run.workflowName}". Re-run the workflow to persist its spec.`,
    )
    return
  }
  const deps: PanelDeps = { extensionUri, runService: runs }
  WorkflowCanvasPanel.render(deps, spec, run)
}

async function openCanvasForFile(
  extensionUri: vscode.Uri,
  runs: RunService,
  uri: vscode.Uri,
): Promise<void> {
  let spec: WorkflowSpec
  try {
    spec = await WorkflowStore.load(uri)
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
    return
  }
  // If a run for this workflow exists, bind it for overlays; otherwise show the spec statically.
  const run = runs.list().find((r) => r.workflowName === spec.name)
  const deps: PanelDeps = { extensionUri, runService: runs }
  WorkflowCanvasPanel.render(deps, spec, run)
}

async function openCanvasViaPicker(extensionUri: vscode.Uri, runs: RunService): Promise<void> {
  const runItems = runs.list().map((r) => ({
    label: `$(run-all) ${r.workflowName}`,
    description: `${r.status} · ${r.runId}`,
    run: r as RunState | undefined,
  }))
  if (runItems.length === 0) {
    void vscode.window.showInformationMessage('No runs to visualize yet. Start one with “Run Workflow”.')
    return
  }
  const picked = await vscode.window.showQuickPick(runItems, { placeHolder: 'Visualize which run?' })
  if (picked?.run) await openCanvasForRun(extensionUri, runs, picked.run)
}
