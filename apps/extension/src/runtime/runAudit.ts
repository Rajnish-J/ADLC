// Phase 4 — append-only run audit. Mirrors the orka `orkaWorkflowAudit` event-log shape (run/step/audit),
// kept separate from the Phase-3 per-evaluator AuditRecord. Pure builder + a JSONL store of the same design
// as auditStore.ts. Every run is attributable (actor) and every transition lands here (exit criterion 4).

import * as vscode from 'vscode'
import type { RunAuditEvent } from './runAuditEvents'

export { deriveRunAuditEvents, type RunAuditEvent, type RunAuditEventKind } from './runAuditEvents'

const DIR = 'runs'
const FILE = 'run-audit.jsonl'

/** Append-only JSONL store for run events. Same read-concat-write design as AuditStore. */
export class RunAuditStore {
  private readonly dir: vscode.Uri
  private readonly file: vscode.Uri
  private readonly _onDidAppend = new vscode.EventEmitter<void>()
  readonly onDidAppend = this._onDidAppend.event

  constructor(globalStorageUri: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(globalStorageUri, DIR)
    this.file = vscode.Uri.joinPath(this.dir, FILE)
  }

  get uri(): vscode.Uri {
    return this.file
  }

  private async readBytes(): Promise<Uint8Array> {
    try {
      return await vscode.workspace.fs.readFile(this.file)
    } catch {
      return new Uint8Array()
    }
  }

  async append(events: RunAuditEvent[]): Promise<void> {
    if (events.length === 0) return
    await vscode.workspace.fs.createDirectory(this.dir)
    const existing = await this.readBytes()
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const addition = Buffer.from(lines, 'utf8')
    const next = existing.length ? Buffer.concat([Buffer.from(existing), addition]) : addition
    await vscode.workspace.fs.writeFile(this.file, next)
    this._onDidAppend.fire()
  }

  async readAll(): Promise<RunAuditEvent[]> {
    const bytes = await this.readBytes()
    if (!bytes.length) return []
    return Buffer.from(bytes)
      .toString('utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as RunAuditEvent
        } catch {
          return null
        }
      })
      .filter((e): e is RunAuditEvent => e !== null)
  }
}
