// Diagnostics — surface manifest issues in VS Code's Problems panel.
//
// Every agent whose status is 'skipped' or 'needs-attention' (or which bundles
// scripts) gets a Diagnostic on its source file, so problems are visible where
// developers already look, not buried in the tree.

import * as vscode from 'vscode'
import type { InternalAgent } from './agentModel'

export function createDiagnostics(): vscode.DiagnosticCollection {
  return vscode.languages.createDiagnosticCollection('sdlcGovernance')
}

/** Replace the diagnostic set with issues from the latest discovery pass. */
export function publishDiagnostics(
  collection: vscode.DiagnosticCollection,
  agents: InternalAgent[],
): void {
  collection.clear()
  const byFile = new Map<string, vscode.Diagnostic[]>()

  for (const agent of agents) {
    if (agent.issues.length === 0) {
      continue
    }
    const severity =
      agent.status === 'skipped'
        ? vscode.DiagnosticSeverity.Error
        : agent.status === 'needs-attention'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information

    const range = new vscode.Range(0, 0, 0, 0)
    const list = byFile.get(agent.sourcePath) ?? []
    for (const message of agent.issues) {
      const diag = new vscode.Diagnostic(range, `[${agent.name}] ${message}`, severity)
      diag.source = 'SDLC Governance'
      list.push(diag)
    }
    byFile.set(agent.sourcePath, list)
  }

  for (const [relPath, diags] of byFile) {
    const uri = resolveUri(relPath)
    if (uri) {
      collection.set(uri, diags)
    }
  }
}

function resolveUri(relPath: string): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) {
    return undefined
  }
  // asRelativePath strips the folder name only when there are multiple roots;
  // try each folder and prefer the first that yields an existing-looking path.
  if (folders.length === 1) {
    return vscode.Uri.joinPath(folders[0].uri, relPath)
  }
  const [first, ...rest] = relPath.split('/')
  const match = folders.find((f) => f.name === first)
  if (match) {
    return vscode.Uri.joinPath(match.uri, rest.join('/'))
  }
  return vscode.Uri.joinPath(folders[0].uri, relPath)
}
