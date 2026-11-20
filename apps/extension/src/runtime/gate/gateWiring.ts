// Phase 4 — vscode glue for the in-run gate. Reads `sdlcGovernance.gate.evaluator` / `.projectEndpoint`,
// resolves (and, in `foundry` mode, asks for) the Foundry project, and mirrors every real evaluation into the
// same audit store / Log Analytics / App Insights path the "Govern & Evaluate" command uses. The decision
// logic itself is in foundryGateEvaluator.ts (vscode-free, unit-tested).

import * as vscode from 'vscode'
import { FOUNDRY_SCOPE } from '../../foundry/constants'
import { getAccountLabel, getToken, isSignedIn } from '../../auth/azureAuth'
import { listAllAccessibleProjects } from '../../foundry/foundryClient'
import { createEvalRunner, type EvalRunner } from '../../eval/evalClient'
import { readLogAnalyticsConfig, readRuntimeConfig, readTelemetrySettings, resolvePolicy } from '../../eval/settings'
import { buildAuditRecords } from '../../audit/auditRecord'
import type { AuditStore } from '../../audit/auditStore'
import { LogAnalyticsSink } from '../../audit/logAnalyticsSink'
import { recordEvalRun } from '../../telemetry/tracing'
import type { EvaluationResultsProvider } from '../../views/evaluationResultsProvider'
import type { GateEvaluationInput, GateEvaluator } from '../port'
import type { GateDecision } from '../../eval/types'
import { StubGateEvaluator } from '../mock/stubs'
import { AutoGateEvaluator, FoundryGateEvaluator } from './foundryGateEvaluator'

export type GateMode = 'auto' | 'foundry' | 'stub'

export interface GateWiringDeps {
  auditStore: AuditStore
  results: EvaluationResultsProvider
  getAppInsightsSecret: (key: string) => Thenable<string | undefined>
  /** Override the eval runner (tests inject a fake). Defaults to the real one. */
  runner?: EvalRunner
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('sdlcGovernance')
}

export function readGateMode(): GateMode {
  const mode = cfg().get<string>('gate.evaluator', 'auto')
  return mode === 'foundry' || mode === 'stub' ? mode : 'auto'
}

function configuredEndpoint(): string | undefined {
  return cfg().get<string>('gate.projectEndpoint')?.trim() || undefined
}

/**
 * Resolve the project to evaluate against: the configured endpoint, else ask ONCE via a QuickPick over the
 * projects this identity can see and persist the answer (workspace if there is one, else user settings).
 * The in-flight promise is shared so several gates reaching it at once produce one prompt.
 */
function makeProjectResolver(): () => Promise<string | undefined> {
  let pending: Promise<string | undefined> | undefined
  return () => {
    const existing = configuredEndpoint()
    if (existing) return Promise.resolve(existing)
    pending ??= (async () => {
      try {
        const projects = await listAllAccessibleProjects(getToken)
        if (projects.length === 0) {
          void vscode.window.showWarningMessage('No accessible Foundry projects found for gate evaluation.')
          return undefined
        }
        const pick = await vscode.window.showQuickPick(
          projects.map((p) => ({ label: p.displayName, description: p.accountName, project: p })),
          { placeHolder: 'Select the Foundry project that evaluates workflow gates', ignoreFocusOut: true },
        )
        if (!pick) return undefined
        const target = vscode.workspace.workspaceFolders
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global
        await cfg().update('gate.projectEndpoint', pick.project.projectEndpoint, target)
        return pick.project.projectEndpoint
      } finally {
        pending = undefined
      }
    })()
    return pending
  }
}

/**
 * Builds the gate every workflow run uses. The mode is read on each evaluation, so changing
 * `sdlcGovernance.gate.evaluator` takes effect on the next gate without a reload.
 */
export function createGateEvaluator(deps: GateWiringDeps): GateEvaluator {
  const runner = deps.runner ?? createEvalRunner(getToken)
  const logSink = new LogAnalyticsSink(readLogAnalyticsConfig(), getToken)
  const stub = new StubGateEvaluator()
  const resolveEndpointInteractively = makeProjectResolver()

  const foundry = new FoundryGateEvaluator({
    runner,
    resolvePolicy,
    runConfig: () => {
      const rc = readRuntimeConfig()
      return { transport: rc.transport, pollIntervalMs: rc.pollIntervalMs, pollTimeoutMs: rc.pollTimeoutMs }
    },
    resolveProjectEndpoint: resolveEndpointInteractively,
    onResult: async ({ result, decision, step, policy, projectEndpoint, timestamp }) => {
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
      const actor = (await getAccountLabel(FOUNDRY_SCOPE)) ?? 'unknown'
      const records = buildAuditRecords({ result, decision, step, actor, source: 'extension', projectEndpoint, timestamp })
      await deps.auditStore.append(records)
      try {
        await logSink.push(records)
      } catch (err) {
        void vscode.window.showWarningMessage(
          `Gate audit saved locally; Log Analytics push failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      deps.results.refresh()
    },
  })

  const auto = new AutoGateEvaluator(
    foundry,
    stub,
    // `auto` never prompts: it needs a project already configured and a signed-in session.
    async () => !!configuredEndpoint() && (await isSignedIn(FOUNDRY_SCOPE)),
    (message) => void vscode.window.showWarningMessage(message),
  )

  return {
    evaluate(input: GateEvaluationInput): Promise<GateDecision> {
      switch (readGateMode()) {
        case 'stub':
          return stub.evaluate(input)
        case 'foundry':
          return foundry.evaluate(input)
        default:
          return auto.evaluate(input)
      }
    },
  }
}
