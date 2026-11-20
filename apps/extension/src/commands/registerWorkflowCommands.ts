// Workflow management commands: open builder, new workflow, duplicate, delete, rename.
// These operate on the WorkflowStore (disk) and refresh the WorkflowsProvider tree.

import * as vscode from 'vscode'
import { isBuiltinWorkflowId, type WorkflowStore } from '../runtime/workflowStore'
import type { DiscoveredAgentsProvider } from '../views/discoveredAgentsProvider'
import type { WorkflowsProvider } from '../views/workflowsProvider'
import { WorkflowCanvasPanel, NEW_WORKFLOW_ID } from '../webview/workflowCanvasPanel'
import type { RunService } from '../runtime/runService'
import type { WorkflowItem } from '../views/workflowsProvider'
import type { AgentSummary } from '../webview/messages'
import { buildBaseWorkflow } from '../runtime/baseWorkflow'

export interface WorkflowCommandDeps {
  store: WorkflowStore
  discovered: DiscoveredAgentsProvider
  workflowsView: WorkflowsProvider
  runs: RunService
  extensionUri: vscode.Uri
  /** Fetch Azure Foundry-registered agents for the builder's Add Agent modal (degrades to []). */
  fetchFoundryAgents?: () => Promise<AgentSummary[]>
}

export function registerWorkflowCommands(
  context: vscode.ExtensionContext,
  deps: WorkflowCommandDeps,
): void {
  const panelDeps = {
    extensionUri: deps.extensionUri,
    runService: deps.runs,
    store: deps.store,
    discovered: deps.discovered,
    workflowsView: deps.workflowsView,
    fetchFoundryAgents: deps.fetchFoundryAgents,
  }
  // Project workflows opened from the platform Workflows view use the same canvas deps.
  WorkflowCanvasPanel.useDefaults(panelDeps)

  context.subscriptions.push(
    // ── Open workflow builder ───────────────────────────────────────────────
    vscode.commands.registerCommand(
      'sdlcGovernance.openWorkflowBuilder',
      async (idOrItem: string | WorkflowItem | undefined, isReadOnlyArg?: boolean) => {
        let id: string
        let isReadOnly: boolean

        if (typeof idOrItem === 'string') {
          id = idOrItem
          isReadOnly = isReadOnlyArg ?? false
        } else if (idOrItem?.entry) {
          id = idOrItem.entry.id
          isReadOnly = idOrItem.entry.isDefault || idOrItem.entry.builtin === true
        } else {
          void vscode.window.showInformationMessage('Select a workflow from the Workflows panel.')
          return
        }

        await WorkflowCanvasPanel.renderBuilder(panelDeps, id, isReadOnly)
      },
    ),

    // ── New workflow ────────────────────────────────────────────────────────
    // Opens the builder in "create mode" — it shows the create-from-agents modal on mount. The
    // workflow is only persisted once the user picks agents and confirms (see the createWorkflow
    // message handler in workflowCanvasPanel). A blank spec is used as the scaffold meanwhile.
    vscode.commands.registerCommand(
      'sdlcGovernance.newWorkflow',
      async () => {
        await WorkflowCanvasPanel.renderBuilder(panelDeps, NEW_WORKFLOW_ID, false, true)
      },
    ),

    // ── Create base workflow from discovered agents ───────────────────────────
    // Maps the real discovered agents into an SDLC-ordered pipeline behind an Azure DevOps issue
    // trigger, so ▶ Start fetches the user's assigned User Stories and runs each agent via Copilot.
    vscode.commands.registerCommand(
      'sdlcGovernance.createBaseWorkflow',
      async () => {
        const agents = deps.discovered.getAgents()
        if (agents.length === 0) {
          void vscode.window.showInformationMessage(
            'No agents discovered yet. Run "Discover Agents" first, then create a base workflow.',
          )
          return
        }

        const ado = await resolveAdoConfig()
        if (ado === undefined) return // user cancelled the prompt

        const spec = buildBaseWorkflow(
          agents.map((a) => ({ id: a.id, name: a.name })),
          { adoOrg: ado.org, adoProject: ado.project },
        )
        const id = `sdlc-base-${Date.now()}`
        await deps.store.save(spec, id)
        deps.workflowsView.refresh()
        void vscode.window.showInformationMessage(
          `Created "${spec.name}" from ${agents.length} discovered agent(s). Opening builder…`,
        )
        await WorkflowCanvasPanel.renderBuilder(panelDeps, id, false)
      },
    ),

    // ── Duplicate workflow ──────────────────────────────────────────────────
    vscode.commands.registerCommand(
      'sdlcGovernance.duplicateWorkflow',
      async (idOrItem: string | WorkflowItem | undefined) => {
        const sourceId =
          typeof idOrItem === 'string'
            ? idOrItem
            : idOrItem?.entry?.id

        if (!sourceId) {
          void vscode.window.showInformationMessage('Select a workflow to duplicate.')
          return
        }

        const sourceSpec = await deps.store.loadById(sourceId)

        const defaultName = `Copy of ${sourceSpec?.name ?? sourceId}`
        const newName = await vscode.window.showInputBox({
          prompt: 'Name for the duplicate',
          value: defaultName,
          validateInput: (v) => (v.trim() ? undefined : 'Name cannot be empty'),
        })
        if (!newName) return

        try {
          const newId = await deps.store.duplicate(sourceId, newName.trim())
          deps.workflowsView.refresh()
          void vscode.window.showInformationMessage(`Created "${newName}". Opening builder…`)
          await WorkflowCanvasPanel.renderBuilder(panelDeps, newId, false)
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Duplicate failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      },
    ),

    // ── Delete workflow ─────────────────────────────────────────────────────
    vscode.commands.registerCommand(
      'sdlcGovernance.deleteWorkflow',
      async (idOrItem: string | WorkflowItem | undefined) => {
        const id =
          typeof idOrItem === 'string'
            ? idOrItem
            : idOrItem?.entry?.id

        if (!id) {
          void vscode.window.showInformationMessage('Select a workflow to delete.')
          return
        }

        if (isBuiltinWorkflowId(id)) {
          void vscode.window.showErrorMessage('Built-in workflows (Story delivery, Quick fix) cannot be deleted.')
          return
        }

        const spec = await deps.store.loadById(id)
        const ok = await vscode.window.showWarningMessage(
          `Delete workflow "${spec?.name ?? id}"? This cannot be undone.`,
          { modal: true },
          'Delete',
        )
        if (ok !== 'Delete') return

        try {
          await deps.store.delete(id)
          deps.workflowsView.refresh()
          void vscode.window.showInformationMessage(`Deleted "${spec?.name ?? id}".`)
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      },
    ),

    // ── Rename workflow ─────────────────────────────────────────────────────
    vscode.commands.registerCommand(
      'sdlcGovernance.renameWorkflow',
      async (idOrItem: string | WorkflowItem | undefined) => {
        const id =
          typeof idOrItem === 'string'
            ? idOrItem
            : idOrItem?.entry?.id

        if (!id) {
          void vscode.window.showInformationMessage('Select a workflow to rename.')
          return
        }

        if (isBuiltinWorkflowId(id)) {
          void vscode.window.showErrorMessage('Built-in workflows (Story delivery, Quick fix) cannot be renamed.')
          return
        }

        const spec = await deps.store.loadById(id)
        const newName = await vscode.window.showInputBox({
          prompt: 'New workflow name',
          value: spec?.name ?? id,
          validateInput: (v) => (v.trim() ? undefined : 'Name cannot be empty'),
        })
        if (!newName) return

        try {
          await deps.store.rename(id, newName.trim())
          deps.workflowsView.refresh()
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      },
    ),
  )
}

/**
 * Resolve the Azure DevOps org/project for the issue trigger. Reads settings; prompts once and
 * persists to workspace settings when either is missing. Returns undefined if the user cancels.
 */
async function resolveAdoConfig(): Promise<{ org: string; project: string } | undefined> {
  const cfg = vscode.workspace.getConfiguration('sdlcGovernance')
  let org = cfg.get<string>('azureDevOps.organization')?.trim() ?? ''
  let project = cfg.get<string>('azureDevOps.project')?.trim() ?? ''

  if (!org) {
    const input = await vscode.window.showInputBox({
      prompt: 'Azure DevOps organization (the dev.azure.com/<org> segment)',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Organization cannot be empty'),
    })
    if (input === undefined) return undefined
    org = input.trim()
    await cfg.update('azureDevOps.organization', org, vscode.ConfigurationTarget.Workspace)
  }

  if (!project) {
    const input = await vscode.window.showInputBox({
      prompt: 'Azure DevOps project name',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Project cannot be empty'),
    })
    if (input === undefined) return undefined
    project = input.trim()
    await cfg.update('azureDevOps.project', project, vscode.ConfigurationTarget.Workspace)
  }

  return { org, project }
}
