// Phase 5C — Microsoft Purview (optional, PREVIEW).
//
// Classifies run content for PII / sensitive-information-types (SIT) and records the classification in
// an append-only store. Two layers: a PURE heuristic detector (the non-preview fallback — always
// available, fully testable) and an optional Purview DSPM-for-AI call when enabled + configured.
// Default OFF (`sdlcGovernance.purview.enabled`). Purview-in-Foundry needs Foundry Account Owner and
// is preview/no-SLA — keep the heuristic fallback on the critical path. See plan §5C + Appendix C.

import * as vscode from 'vscode'
import type { PurviewClassificationRecord } from './purviewClassify'

export {
  buildClassificationRecord,
  classifyContent,
  classifyHeuristic,
  PurviewApiError,
  type DetectedType,
  type PurviewClassification,
  type PurviewClassificationRecord,
  type PurviewConfig,
  type SensitiveInfoType,
} from './purviewClassify'

const DIR = 'purview'
const FILE = 'classifications.jsonl'

/** Append-only JSONL store for Purview/heuristic classifications. */
export class PurviewClassificationStore {
  private readonly dir: vscode.Uri
  private readonly file: vscode.Uri

  constructor(globalStorageUri: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(globalStorageUri, DIR)
    this.file = vscode.Uri.joinPath(this.dir, FILE)
  }

  get uri(): vscode.Uri {
    return this.file
  }

  async append(record: PurviewClassificationRecord): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.dir)
    let existing: Uint8Array = new Uint8Array()
    try {
      existing = await vscode.workspace.fs.readFile(this.file)
    } catch {
      /* first write */
    }
    const addition = Buffer.from(JSON.stringify(record) + '\n', 'utf8')
    const next = existing.length ? Buffer.concat([Buffer.from(existing), addition]) : addition
    await vscode.workspace.fs.writeFile(this.file, next)
  }
}
