// Phase 3 — optional Log Analytics / SIEM sink (DESIGNED-FOR, not required to
// ship). Mirrors audit records to a Log Analytics workspace via the Logs
// Ingestion API (Data Collection Rule endpoint), using the existing
// TokenProvider abstraction with the Azure Monitor scope — no new auth code.
//
// Behind config `sdlcGovernance.audit.logAnalytics.enabled`. When disabled the
// `push` is a no-op, so callers can wire it unconditionally.

import type { TokenProvider } from '../foundry/foundryClient'
import type { AuditRecord } from './auditRecord'

const MONITOR_SCOPE = 'https://monitor.azure.com/.default'
const INGESTION_API = '2023-01-01'

export interface LogAnalyticsConfig {
  enabled: boolean
  /** DCR data-collection endpoint, e.g. https://<name>.<region>.ingest.monitor.azure.com */
  dcrEndpoint?: string
  /** Immutable id of the Data Collection Rule (dcr-xxxx…). */
  dcrImmutableId?: string
  /** Custom table stream name, e.g. Custom-SdlcEvalAudit_CL. */
  streamName?: string
}

export class LogAnalyticsSink {
  constructor(
    private readonly config: LogAnalyticsConfig,
    private readonly getToken: TokenProvider,
  ) {}

  /** Push records to Log Analytics. No-op when disabled or misconfigured. */
  async push(records: AuditRecord[]): Promise<void> {
    if (!this.config.enabled || records.length === 0) {
      return
    }
    const { dcrEndpoint, dcrImmutableId, streamName } = this.config
    if (!dcrEndpoint || !dcrImmutableId || !streamName) {
      throw new Error(
        'Log Analytics sink enabled but dcrEndpoint / dcrImmutableId / streamName are not configured.',
      )
    }
    const token = await this.getToken(MONITOR_SCOPE)
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
      throw new Error(`Log Analytics ingestion failed (${res.status}): ${text.slice(0, 300) || res.statusText}`)
    }
  }
}
