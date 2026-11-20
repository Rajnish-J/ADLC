// Phase 3 — "Scaffold ADO Eval Gate" command. Picks a step + judge model, writes
// the gate pipeline/dataset/README, then optionally creates the cost budget and
// prints the operator checklist.

import * as vscode from 'vscode'
import { getToken } from '../auth/azureAuth'
import { listAllAccessibleProjects } from '../foundry/foundryClient'
import { SDLC_STEPS, STEP_LABELS, type SdlcStep } from '../eval/sdlcSteps'
import { resolvePolicy } from '../eval/settings'
import { writeScaffold } from '../scaffold/pipelineScaffolder'
import { ensureBudget } from '../eval/budgetScaffolder'

export async function scaffoldAdoGate(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    void vscode.window.showWarningMessage('Open a workspace folder to scaffold the evaluation gate.')
    return
  }

  const stepPick = await vscode.window.showQuickPick(
    SDLC_STEPS.map((s) => ({ label: STEP_LABELS[s], step: s })),
    { placeHolder: 'Which SDLC step should the gate govern?' },
  )
  if (!stepPick) {
    return
  }
  const step: SdlcStep = stepPick.step

  const policy = await resolvePolicy()
  const written = await writeScaffold(folder.uri, { step, judgeDeployment: policy.judgeDeployment })

  if (written.length === 0) {
    void vscode.window.showInformationMessage('No files written (existing files kept).')
    return
  }

  // Offer to create the Azure budget for the Foundry resource group.
  const wantBudget = await vscode.window.showInformationMessage(
    `Scaffolded ${written.length} file(s). Create an Azure cost budget for the Foundry resource group?`,
    'Create budget',
    'Skip',
  )
  if (wantBudget === 'Create budget') {
    await offerBudget()
  }

  // Open the README so the operator sees the prerequisites checklist.
  const readme = written.find((w) => w.path.endsWith('README.md'))
  if (readme) {
    await vscode.window.showTextDocument(readme.uri)
  }
}

async function offerBudget(): Promise<void> {
  try {
    const projects = await listAllAccessibleProjects(getToken)
    if (projects.length === 0) {
      void vscode.window.showWarningMessage('No accessible Foundry projects to scope a budget to.')
      return
    }
    const pick = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.displayName, description: `${p.resourceGroup} · ${p.subscriptionId}`, project: p })),
      { placeHolder: 'Scope the budget to which Foundry project’s resource group?' },
    )
    if (!pick) {
      return
    }
    const amountStr = await vscode.window.showInputBox({
      prompt: 'Monthly budget amount (in your billing currency)',
      value: '100',
      validateInput: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? undefined : 'Enter a positive number'),
    })
    if (!amountStr) {
      return
    }
    const result = await ensureBudget(getToken, {
      subscriptionId: pick.project.subscriptionId,
      resourceGroup: pick.project.resourceGroup,
      amount: Number(amountStr),
      alertPercent: 80,
    })
    if (result.created) {
      void vscode.window.showInformationMessage(`Budget “${result.name}” created (alert at 80%).`)
    } else {
      void vscode.window.showWarningMessage(
        `Could not create the budget automatically. Run this instead:\n${result.cliFallback}`,
      )
    }
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Budget setup failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
