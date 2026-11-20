// Shared "seed a run's inputs from its trigger" logic, used by both the `@sdlc` chat participant and
// the canvas panel's Start button. Issue triggers fetch + let the user pick an assigned ADO work item;
// manual triggers take a free-text task. UI is abstracted behind SeedRunInputsUI so each caller can
// render progress/picks its own way (chat markdown stream vs VS Code notifications/QuickPick).

import * as vscode from 'vscode'
import { ADO_SCOPE } from '../foundry/constants'
import { getToken } from '../auth/azureAuth'
import type { SpecNode, SpecNodeData } from '../runtime/spec'
import type { AdoToolConfig } from '../runtime/dispatch/adoTools'
import {
  fetchAssignedWorkItems,
  workItemToTaskPrompt,
  DEFAULT_WORK_ITEM_TYPE,
  type WorkItem,
} from '../integrations/azureDevOps/adoClient'

export type SeededInputs = Record<string, unknown> & { ado?: AdoToolConfig }

export interface SeedRunInputsUI {
  /** Transient progress message (e.g. "Fetching your work items…"). */
  progress(message: string): void
  /** Persistent informational/warning message (error, empty result, etc). */
  info(message: string): void
  /** Ask for a free-text task description. Undefined if the user cancels/leaves it empty. */
  askTask(): Promise<string | undefined>
  /** Let the user pick one work item from the fetched list. Undefined if cancelled. */
  pickWorkItem(items: WorkItem[]): Promise<WorkItem | undefined>
}

/**
 * Seed a run's inputs from its trigger node. Issue trigger → fetch + pick an ADO work item (also
 * returns an `ado` connection so the dispatcher can offer board tools); manual trigger → free-text task.
 */
export async function seedRunInputs(
  trigger: SpecNode | undefined,
  ui: SeedRunInputsUI,
  token?: vscode.CancellationToken,
): Promise<SeededInputs | undefined> {
  const d = trigger?.data
  if (d?.triggerType !== 'issue') {
    const task = await ui.askTask()
    if (!task) {
      ui.info('No task provided.')
      return undefined
    }
    return { task }
  }

  const resolved = await resolveAdoOrgProject(d, ui)
  if (!resolved) return undefined
  const { org, project } = resolved

  ui.progress(`Fetching your work items from ${org}/${project}…`)
  let items: WorkItem[]
  try {
    const adoToken = await getToken(ADO_SCOPE)
    items = await fetchAssignedWorkItems({
      org,
      project,
      token: adoToken,
      workItemType: d.workItemType || DEFAULT_WORK_ITEM_TYPE,
      wiql: d.wiql,
    })
  } catch (err) {
    ui.info(`Could not fetch work items: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
  if (token?.isCancellationRequested) return undefined

  if (items.length === 0) {
    ui.info(`No ${d.workItemType || DEFAULT_WORK_ITEM_TYPE} work items are assigned to you in ${org}/${project}.`)
    return undefined
  }

  const picked = await ui.pickWorkItem(items)
  if (!picked) {
    ui.info('No work item picked.')
    return undefined
  }

  return {
    task: workItemToTaskPrompt(picked),
    workItemId: picked.id,
    workItemUrl: picked.url,
    ado: {
      org,
      project,
      getToken: () => getToken(ADO_SCOPE),
      workItemId: picked.id,
    },
  }
}

/**
 * Resolve the Azure DevOps org/project for an issue trigger: trigger node data, then the
 * `sdlcGovernance` setting, then (if still missing) prompt the user once and persist the answers
 * to workspace settings — mirrors `resolveAdoConfig` in registerWorkflowCommands.ts so "Start"
 * resolves config on the spot instead of dead-ending with just a warning.
 */
async function resolveAdoOrgProject(
  d: SpecNodeData | undefined,
  ui: SeedRunInputsUI,
): Promise<{ org: string; project: string } | undefined> {
  const cfg = vscode.workspace.getConfiguration('sdlcGovernance')
  let org = d?.adoOrg?.trim() || cfg.get<string>('azureDevOps.organization')?.trim() || ''
  let project = d?.adoProject?.trim() || cfg.get<string>('azureDevOps.project')?.trim() || ''

  if (!org) {
    const input = await vscode.window.showInputBox({
      prompt: 'Azure DevOps organization (the dev.azure.com/<org> segment)',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Organization cannot be empty'),
    })
    if (input === undefined) {
      ui.info('Issue trigger needs an Azure DevOps organization and project to start this run.')
      return undefined
    }
    org = input.trim()
    await cfg.update('azureDevOps.organization', org, vscode.ConfigurationTarget.Workspace)
  }

  if (!project) {
    const input = await vscode.window.showInputBox({
      prompt: 'Azure DevOps project name',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Project cannot be empty'),
    })
    if (input === undefined) {
      ui.info('Issue trigger needs an Azure DevOps organization and project to start this run.')
      return undefined
    }
    project = input.trim()
    await cfg.update('azureDevOps.project', project, vscode.ConfigurationTarget.Workspace)
  }

  return { org, project }
}
