// Phase 3 — command registration aggregator. Keeps extension.ts thin: it
// constructs the dependencies (audit store, results view, eval runner, sink) and
// hands them here. Each handler takes injected deps so it's testable with fakes.

import * as vscode from 'vscode'
import { getToken } from '../auth/azureAuth'
import { createEvalRunner } from '../eval/evalClient'
import { LogAnalyticsSink, type LogAnalyticsConfig } from '../audit/logAnalyticsSink'
import type { AuditStore } from '../audit/auditStore'
import type { SecretStore } from '../secrets/secretStore'
import type { EvaluationResultsProvider } from '../views/evaluationResultsProvider'
import type { EvalRunner } from '../eval/evalClient'
import { governAndEvaluate } from './governAndEvaluate'
import { openEvaluationResults } from './openEvaluationResults'
import { scaffoldAdoGate } from './scaffoldAdoGate'
import { evaluateAgent } from './evaluateAgent'
import { governAgent } from './governAgent'
import { EvalOutputChannel } from '../telemetry/evalOutputChannel'

export interface EvalCommandDeps {
  store: AuditStore
  results: EvaluationResultsProvider
  secrets: SecretStore
  /** Override the eval runner (tests inject a fake). Defaults to the real one. */
  runner?: EvalRunner
}

function readLogAnalyticsConfig(): LogAnalyticsConfig {
  const c = vscode.workspace.getConfiguration('sdlcGovernance')
  return {
    enabled: c.get<boolean>('audit.logAnalytics.enabled') ?? false,
    dcrEndpoint: c.get<string>('audit.logAnalytics.dcrEndpoint'),
    dcrImmutableId: c.get<string>('audit.logAnalytics.dcrImmutableId'),
    streamName: c.get<string>('audit.logAnalytics.streamName'),
  }
}

export function registerEvalCommands(context: vscode.ExtensionContext, deps: EvalCommandDeps): void {
  const runner = deps.runner ?? createEvalRunner(getToken)
  const logSink = new LogAnalyticsSink(readLogAnalyticsConfig(), getToken)
  // The shared live-log channel, created once and reused across every run (AC-3).
  const channel = new EvalOutputChannel(context.globalStorageUri)
  context.subscriptions.push(channel)

  context.subscriptions.push(
    vscode.commands.registerCommand('sdlcGovernance.governAndEvaluate', () =>
      governAndEvaluate({
        runner,
        store: deps.store,
        results: deps.results,
        logSink,
        getAppInsightsSecret: (key) => deps.secrets.get(key),
      }),
    ),

    vscode.commands.registerCommand('sdlcGovernance.openEvaluationResults', () =>
      openEvaluationResults(deps.results),
    ),

    vscode.commands.registerCommand('sdlcGovernance.scaffoldAdoGate', () => scaffoldAdoGate()),

    vscode.commands.registerCommand('sdlcGovernance.evaluateAgent', (arg?: unknown) =>
      evaluateAgent(arg, { runner, store: deps.store, results: deps.results, logSink, channel }),
    ),

    vscode.commands.registerCommand('sdlcGovernance.governAgent', (arg?: unknown) =>
      governAgent(arg, { store: deps.store, results: deps.results, channel }),
    ),

    // Reveals the shared "SDLC Evaluation Log" channel — invoked by the "View run
    // log" node in the Evaluation Results tree (AC-4). A dedicated command focuses
    // our exact channel reliably across VS Code versions.
    vscode.commands.registerCommand('sdlcGovernance.showEvalLog', () => channel.reveal()),
  )
}
