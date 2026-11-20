// Phase 3 — the "Govern & Evaluate" command. The end-to-end local run:
// discover agents → build the dataset for an SDLC step → run Foundry evaluators
// → decide the gate → trace, audit, and surface results. The local run is
// ADVISORY (it warns on fail); the scaffolded ADO gate is the hard block.

import * as vscode from 'vscode'
import { FOUNDRY_SCOPE } from '../foundry/constants'
import { getToken, getAccountLabel, getSession } from '../auth/azureAuth'
import { listAllAccessibleProjects } from '../foundry/foundryClient'
import { discover } from '../discovery/normalizer'
import type { InternalAgent } from '../discovery/agentModel'
import { SDLC_STEPS, STEP_LABELS, LOWER_IS_BETTER, type SdlcStep } from '../eval/sdlcSteps'
import { buildDataset } from '../eval/datasetBuilder'
import { decideGate } from '../eval/gateDecision'
import { ensureCustomEvaluators } from '../eval/customEvaluators'
import { tryCreateProjectClient, type EvalRunner } from '../eval/evalClient'
import { resolvePolicy, readRuntimeConfig, readTelemetrySettings } from '../eval/settings'
import { buildAuditRecords } from '../audit/auditRecord'
import type { AuditStore } from '../audit/auditStore'
import type { LogAnalyticsSink } from '../audit/logAnalyticsSink'
import { recordEvalRun } from '../telemetry/tracing'
import type { EvaluationResultsProvider } from '../views/evaluationResultsProvider'

export interface GovernAndEvaluateDeps {
  runner: EvalRunner
  store: AuditStore
  results: EvaluationResultsProvider
  logSink: LogAnalyticsSink
  getAppInsightsSecret: (key: string) => Thenable<string | undefined>
  /** Injectable clock for deterministic tests; defaults to Date. */
  now?: () => Date
}

async function pickStep(): Promise<SdlcStep | undefined> {
  const pick = await vscode.window.showQuickPick(
    SDLC_STEPS.map((s) => ({ label: STEP_LABELS[s], step: s })),
    { placeHolder: 'Which SDLC step are you governing?' },
  )
  return pick?.step
}

export async function governAndEvaluate(deps: GovernAndEvaluateDeps): Promise<void> {
  const now = deps.now ?? (() => new Date())

  // 1. Auth.
  const session = await getSession(FOUNDRY_SCOPE, true)
  if (!session) {
    void vscode.window.showWarningMessage('Sign in to Azure first (SDLC Governance: Sign in to Azure).')
    return
  }

  // 2. Step + policy.
  const step = await pickStep()
  if (!step) {
    return
  }
  const policy = await resolvePolicy()
  const runtime = readRuntimeConfig()
  const stepPolicy = policy.steps[step]
  if (!stepPolicy || stepPolicy.evaluators.length === 0) {
    void vscode.window.showWarningMessage(`No evaluators configured for the “${STEP_LABELS[step]}” step.`)
    return
  }

  // 3. Agents.
  const { agents } = await discover()
  const valid = agents.filter((a: InternalAgent) => a.status === 'valid')
  if (valid.length === 0) {
    void vscode.window.showWarningMessage('No valid discovered agents to evaluate. Run Discover first.')
    return
  }

  // 4. Foundry project.
  const projects = await listAllAccessibleProjects(getToken)
  if (projects.length === 0) {
    void vscode.window.showWarningMessage('No accessible Foundry projects found.')
    return
  }
  const projectPick = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.displayName, description: p.accountName, project: p })),
    { placeHolder: 'Select the Foundry project to evaluate against' },
  )
  if (!projectPick) {
    return
  }
  const project = projectPick.project

  // 5. Dataset.
  const stamp = now().toISOString()
  const dataset = buildDataset(valid, policy, { step, name: `sdlc-${step}-${stamp}` })

  // 6. Optional custom evaluators (preview, degrade).
  if (runtime.customEvaluators) {
    const client = await tryCreateProjectClient(project.projectEndpoint, getToken)
    if (client) {
      const extra = await ensureCustomEvaluators(client, policy.judgeDeployment, (m) =>
        vscode.window.showInformationMessage(m),
      )
      dataset.evaluators.push(...extra)
    }
  }

  // 7. Run + gate, under a cancellable progress.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Evaluating ${STEP_LABELS[step]} step…`, cancellable: true },
    async (progress, cancelToken) => {
      try {
        const result = await deps.runner.run(dataset, {
          projectEndpoint: project.projectEndpoint,
          transport: runtime.transport,
          pollIntervalMs: runtime.pollIntervalMs,
          pollTimeoutMs: runtime.pollTimeoutMs,
          isCancelled: () => cancelToken.isCancellationRequested,
          onProgress: (e) => progress.report({ message: `${e.status} (poll ${e.poll}/${e.maxPolls})` }),
        })

        // LOWER_IS_BETTER: safety evaluators score a severity where higher is WORSE — without this a severe
        // score would pass a "≥ threshold" check. (evaluateAgent.ts already passes it.)
        const decision = decideGate(result.scores, stepPolicy, policy.failClosedOnError, LOWER_IS_BETTER)

        // 8. Trace.
        const telemetry = await readTelemetrySettings(deps.getAppInsightsSecret)
        if (telemetry.enabled) {
          recordEvalRun({
            result,
            decision,
            step,
            judgeDeployment: policy.judgeDeployment,
            recordContent: telemetry.recordContent,
          })
        }

        // 9. Audit (+ optional SIEM mirror).
        const actor = (await getAccountLabel(FOUNDRY_SCOPE)) ?? 'unknown'
        const records = buildAuditRecords({
          result,
          decision,
          step,
          actor,
          source: 'extension',
          projectEndpoint: project.projectEndpoint,
          timestamp: stamp,
        })
        await deps.store.append(records)
        try {
          await deps.logSink.push(records)
        } catch (err) {
          void vscode.window.showWarningMessage(
            `Audit saved locally; Log Analytics push failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        // 10. Surface.
        deps.results.refresh()
        if (decision.pass) {
          void vscode.window.showInformationMessage(`Gate PASSED for ${STEP_LABELS[step]} — ${decision.reason}.`)
        } else {
          const action = await vscode.window.showWarningMessage(
            `Gate FAILED for ${STEP_LABELS[step]} — ${decision.reason}.`,
            'Show Results',
          )
          if (action === 'Show Results') {
            await vscode.commands.executeCommand('sdlcGovernance.showEvaluations')
          }
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )
}
