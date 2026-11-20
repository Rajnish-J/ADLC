// Phase 3 — "Open Evaluation Results": refresh and reveal the results view.

import * as vscode from 'vscode'
import type { EvaluationResultsProvider } from '../views/evaluationResultsProvider'

export async function openEvaluationResults(results: EvaluationResultsProvider): Promise<void> {
  results.refresh()
  await vscode.commands.executeCommand('sdlcGovernance.showEvaluations')
}
