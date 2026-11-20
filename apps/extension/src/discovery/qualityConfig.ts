// Quality-rules loader — reads the user-editable criteria file.
//
// Touches the `vscode` filesystem (like scanner.ts). Reads
// `.claude/governance/agent-quality.yaml` from the first workspace folder and
// parses it with the pure parseQualityRules. When the file is absent or
// unreadable, DEFAULT_QUALITY_RULES are returned so the feature always works.

import * as vscode from 'vscode'
import {
  DEFAULT_QUALITY_RULES,
  parseQualityRules,
  type QualityRules,
} from './suggestions'

/** Workspace-relative path of the criteria file (POSIX). */
export const QUALITY_RULES_PATH = '.claude/governance/agent-quality.yaml'

const decoder = new TextDecoder('utf-8')

/** Load the quality rules for the current workspace, falling back to defaults. */
export async function loadQualityRules(): Promise<QualityRules> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    return { ...DEFAULT_QUALITY_RULES }
  }
  const uri = vscode.Uri.joinPath(folder.uri, QUALITY_RULES_PATH)
  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    return parseQualityRules(decoder.decode(bytes))
  } catch {
    return { ...DEFAULT_QUALITY_RULES }
  }
}
