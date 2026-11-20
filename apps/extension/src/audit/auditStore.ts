// Phase 3 — the append-only audit store.
//
// Every evaluator result and gate decision lands here, not just in the IDE —
// satisfying the "append-only record of the run and the gate decision" exit
// criterion. Local-first: a JSONL file under the extension's global storage.
// An optional Log Analytics push (logAnalyticsSink.ts) can mirror records to a
// SIEM later; the store doesn't know or care.
//
// Append-only is enforced by the API surface: there is no update or delete.
// VS Code's FileSystem has no append mode, so we read-concat-write; acceptable
// for single-window extension use (noted as not concurrency-safe).

import * as vscode from 'vscode'
import { fromJsonl, toJsonl, type AuditRecord } from './auditRecord'

const AUDIT_DIR = 'audit'
const AUDIT_FILE = 'eval-audit.jsonl'

export class AuditStore {
  private readonly dir: vscode.Uri
  private readonly file: vscode.Uri
  private readonly _onDidAppend = new vscode.EventEmitter<void>()
  /** Fires after records are appended, so views can refresh. */
  readonly onDidAppend = this._onDidAppend.event

  constructor(globalStorageUri: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(globalStorageUri, AUDIT_DIR)
    this.file = vscode.Uri.joinPath(this.dir, AUDIT_FILE)
  }

  /** Absolute path to the audit log (for surfacing to the user). */
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

  /** Append records as JSONL lines. Never rewrites existing content. */
  async append(records: AuditRecord[]): Promise<void> {
    if (records.length === 0) {
      return
    }
    await vscode.workspace.fs.createDirectory(this.dir)
    const existing = await this.readBytes()
    const lines = records.map(toJsonl).join('\n') + '\n'
    const addition = Buffer.from(lines, 'utf8')
    const next = existing.length ? Buffer.concat([Buffer.from(existing), addition]) : addition
    await vscode.workspace.fs.writeFile(this.file, next)
    this._onDidAppend.fire()
  }

  /** Read all records (oldest first). */
  async readAll(): Promise<AuditRecord[]> {
    const bytes = await this.readBytes()
    if (!bytes.length) {
      return []
    }
    return Buffer.from(bytes)
      .toString('utf8')
      .split('\n')
      .map(fromJsonl)
      .filter((r): r is AuditRecord => r !== null)
  }

  /** Read the most recent `n` records (newest first). */
  async readRecent(n: number): Promise<AuditRecord[]> {
    const all = await this.readAll()
    return all.slice(Math.max(0, all.length - n)).reverse()
  }
}
