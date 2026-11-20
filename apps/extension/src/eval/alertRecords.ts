// Pure continuous-eval alert records + Log Analytics delivery, split from alertSink.ts so they carry no
// `vscode` dependency. alertSink.ts keeps the JSONL store and the VS Code notification.

import type { TokenProvider } from '../foundry/foundryClient'
import type { LogAnalyticsConfig } from '../audit/logAnalyticsSink'
import type { ContinuousAlert } from './continuousEval'

const MONITOR_SCOPE = 'https://monitor.azure.com/.default'
const INGESTION_API = '2023-01-01'

export interface ContinuousAlertRecord {
  schemaVersion: 1
  timestamp: string // ISO8601
  kind: ContinuousAlert['kind']
  runId?: string
  step?: string
  evaluator?: string
  value: number
  threshold: number
  message: string
}

/** Pure: stamp alerts into append-ready records. Caller supplies the timestamp (deterministic tests). */
export function buildAlertRecords(alerts: ContinuousAlert[], timestamp: string): ContinuousAlertRecord[] {
  return alerts.map((a) => ({
    schemaVersion: 1 as const,
    timestamp,
    kind: a.kind,
    runId: a.runId,
    step: a.step,
    evaluator: a.evaluator,
    value: a.value,
    threshold: a.threshold,
    message: a.message,
  }))
}

/** Push alert rows to Log Analytics via the Logs Ingestion API. No-op when disabled/misconfigured. */
export async function pushAlertsToLogAnalytics(
  records: ContinuousAlertRecord[],
  config: LogAnalyticsConfig,
  getToken: TokenProvider,
): Promise<void> {
  if (!config.enabled || records.length === 0) return
  const { dcrEndpoint, dcrImmutableId, streamName } = config
  if (!dcrEndpoint || !dcrImmutableId || !streamName) return
  const token = await getToken(MONITOR_SCOPE)
  const url =
    `${dcrEndpoint.replace(/\/+$/, '')}/dataCollectionRules/${encodeURIComponent(dcrImmutableId)}` +
    `/streams/${encodeURIComponent(streamName)}?api-version=${INGESTION_API}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(records),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Alert ingestion failed (${res.status}): ${text.slice(0, 200) || res.statusText}`)
  }
}
