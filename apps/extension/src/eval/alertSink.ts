// Phase 5D — continuous-evaluation alert delivery.
//
// Turns the pure ContinuousAlerts from continuousEval.ts into durable, attributable records and
// delivers them: (1) an append-only JSONL store (same design as RunAuditStore — satisfies the "audit
// entry appended" exit criterion), (2) optional Log Analytics / SIEM rows via the Logs Ingestion API
// (the same DCR config Phase 3 uses), and (3) a VS Code notification so a regression is visible. The
// record builder is pure + unit-testable; the delivery is vscode-coupled. See plan §5D.

import * as vscode from 'vscode'
import type { ContinuousAlertRecord } from './alertRecords'
import type { ContinuousAlert } from './continuousEval'

export { buildAlertRecords, pushAlertsToLogAnalytics, type ContinuousAlertRecord } from './alertRecords'

const DIR = 'continuous-eval'
const FILE = 'alerts.jsonl'

/** Append-only JSONL store for continuous-eval alerts. Same read-concat-write design as RunAuditStore. */
export class ContinuousAlertStore {
  private readonly dir: vscode.Uri
  private readonly file: vscode.Uri

  constructor(globalStorageUri: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(globalStorageUri, DIR)
    this.file = vscode.Uri.joinPath(this.dir, FILE)
  }

  get uri(): vscode.Uri {
    return this.file
  }

  async append(records: ContinuousAlertRecord[]): Promise<void> {
    if (records.length === 0) return
    await vscode.workspace.fs.createDirectory(this.dir)
    let existing: Uint8Array = new Uint8Array()
    try {
      existing = await vscode.workspace.fs.readFile(this.file)
    } catch {
      /* first write */
    }
    const addition = Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    const next = existing.length ? Buffer.concat([Buffer.from(existing), addition]) : addition
    await vscode.workspace.fs.writeFile(this.file, next)
  }
}

/** Show a single, summarized VS Code notification for a batch of alerts (avoids notification spam). */
export function notifyAlerts(alerts: ContinuousAlert[]): void {
  if (alerts.length === 0) return
  const regressions = alerts.filter((a) => a.kind === 'quality-regression').length
  const spend = alerts.some((a) => a.kind === 'eval-spend')
  const parts: string[] = []
  if (regressions > 0) parts.push(`${regressions} quality regression(s)`)
  if (spend) parts.push('eval-spend over budget')
  void vscode.window.showWarningMessage(
    `Continuous evaluation: ${parts.join(', ')}. See the continuous-eval alert log.`,
  )
}
