// Phase 3 — settings glue. The `vscode`-touching bridge between extension
// configuration / the workspace policy file and the pure `resolveGatePolicy`.
// Kept thin so the policy logic itself stays testable without `vscode`.

import * as vscode from 'vscode'
import { resolveGatePolicy, type EvalConfigDefaults } from './gatePolicy'
import type { GatePolicy } from './types'
import { DEFAULT_CONTINUOUS_CONFIG, type ContinuousEvalConfig } from './continuousEval'
import type { LogAnalyticsConfig } from '../audit/logAnalyticsSink'
import type { PurviewConfig } from '../foundry/purview'

const WORKSPACE_POLICY_PATH = '.sdlc/governance.eval.json'

export interface RuntimeEvalConfig {
  transport: 'sdk' | 'fetch'
  pollIntervalMs: number
  pollTimeoutMs: number
  customEvaluators: boolean
}

export interface TelemetrySettings {
  enabled: boolean
  recordContent: boolean
  connectionString?: string
}

function cfg() {
  return vscode.workspace.getConfiguration('sdlcGovernance')
}

/** Read the org-wide config defaults that feed the gate policy. */
function readConfigDefaults(): EvalConfigDefaults {
  const c = cfg()
  return {
    judgeDeployment: c.get<string>('eval.judgeDeployment'),
    failClosedOnError: c.get<boolean>('eval.failClosedOnError'),
    sampling: c.get<EvalConfigDefaults['sampling']>('eval.sampling'),
    defaultThresholds: c.get<Record<string, number>>('gate.defaultThresholds'),
  }
}

/** Read and parse the workspace `.sdlc/governance.eval.json`, if present. */
export async function readWorkspacePolicyFile(): Promise<unknown> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    return undefined
  }
  const uri = vscode.Uri.joinPath(folder.uri, WORKSPACE_POLICY_PATH)
  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return undefined
  }
}

/** Resolve the effective gate policy (workspace file over config over built-ins). */
export async function resolvePolicy(): Promise<GatePolicy> {
  const workspaceFile = await readWorkspacePolicyFile()
  return resolveGatePolicy(workspaceFile, readConfigDefaults())
}

/** Read the Phase-5D continuous-evaluation config (over built-in defaults). */
export function readContinuousEvalConfig(): ContinuousEvalConfig {
  const c = cfg()
  return {
    enabled: c.get<boolean>('continuousEval.enabled') ?? DEFAULT_CONTINUOUS_CONFIG.enabled,
    sampleRate: c.get<number>('continuousEval.sampleRate') ?? DEFAULT_CONTINUOUS_CONFIG.sampleRate,
    minSamples: c.get<number>('continuousEval.minSamples') ?? DEFAULT_CONTINUOUS_CONFIG.minSamples,
    alertThreshold:
      c.get<number>('continuousEval.alertThreshold') ?? DEFAULT_CONTINUOUS_CONFIG.alertThreshold,
    evalSpendBudgetRatio:
      c.get<number>('continuousEval.evalSpendBudgetRatio') ??
      DEFAULT_CONTINUOUS_CONFIG.evalSpendBudgetRatio,
  }
}

/** Read the Log Analytics / SIEM destination (shared by the audit mirror and the 5D alert sink). */
export function readLogAnalyticsConfig(): LogAnalyticsConfig {
  const c = cfg()
  return {
    enabled: c.get<boolean>('audit.logAnalytics.enabled') ?? false,
    dcrEndpoint: c.get<string>('audit.logAnalytics.dcrEndpoint') || undefined,
    dcrImmutableId: c.get<string>('audit.logAnalytics.dcrImmutableId') || undefined,
    streamName: c.get<string>('audit.logAnalytics.streamName') || undefined,
  }
}

/** Read the Phase-5C Purview config (default off — heuristic fallback otherwise). */
export function readPurviewConfig(): PurviewConfig {
  const c = cfg()
  return {
    enabled: c.get<boolean>('purview.enabled') ?? false,
    endpoint: c.get<string>('purview.endpoint') || undefined,
  }
}

/** Read runtime knobs (transport, polling, custom evaluators). */
export function readRuntimeConfig(): RuntimeEvalConfig {
  const c = cfg()
  return {
    transport: c.get<'sdk' | 'fetch'>('eval.transport') ?? 'sdk',
    pollIntervalMs: c.get<number>('eval.pollIntervalMs') ?? 5_000,
    pollTimeoutMs: c.get<number>('eval.pollTimeoutMs') ?? 600_000,
    customEvaluators: c.get<boolean>('eval.customEvaluators') ?? false,
  }
}

/**
 * Read telemetry settings. The App Insights connection string is resolved
 * secret-first (SecretStorage) then config, so it need not live in settings.json.
 */
export async function readTelemetrySettings(
  getSecret: (key: string) => Thenable<string | undefined>,
): Promise<TelemetrySettings> {
  const c = cfg()
  const fromSecret = await getSecret('sdlcGovernance.appInsightsConnectionString')
  const fromConfig = c.get<string>('telemetry.appInsightsConnectionString')
  return {
    enabled: c.get<boolean>('telemetry.enabled') ?? false,
    recordContent: c.get<boolean>('telemetry.recordContent') ?? false,
    connectionString: fromSecret || fromConfig || undefined,
  }
}
