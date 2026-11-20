// Workspace scanner — the ONLY module in src/discovery that touches the
// filesystem / `vscode` APIs. It locates candidate manifests, reads them, and
// hands the text to the pure adapters.
//
// SECURITY: scanning READS and PARSES files only. No discovered file is ever
// executed, required, spawned, or evaluated. For SKILL.md, we additionally check
// for sibling executable files purely to set the `hasBundledScripts` audit flag —
// we list names, we never run them.

import * as vscode from 'vscode'
import type { InternalAgent } from './agentModel'
import { ADAPTERS } from './adapters'

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}'

const SCRIPT_EXTENSIONS = /\.(sh|bash|ps1|py|js|cjs|mjs|rb|pl)$/i

const decoder = new TextDecoder('utf-8')

/** Scan every workspace folder with every adapter; returns raw (pre-dedupe) agents. */
export async function scanWorkspace(token?: vscode.CancellationToken): Promise<InternalAgent[]> {
  const folders = vscode.workspace.workspaceFolders ?? []
  const all: InternalAgent[] = []

  for (const folder of folders) {
    for (const adapter of ADAPTERS) {
      for (const glob of adapter.globs) {
        if (token?.isCancellationRequested) {
          return all
        }
        const pattern = new vscode.RelativePattern(folder, glob)
        const uris = await vscode.workspace.findFiles(pattern, EXCLUDE)
        for (const uri of uris) {
          if (token?.isCancellationRequested) {
            return all
          }
          const content = await readText(uri)
          if (content === undefined) {
            continue
          }
          const relPath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
          const agents = adapter.parse(relPath, content)

          // SKILL.md audit flag: does the skill folder bundle executable files?
          if (adapter.kind === 'claude-skill') {
            const bundled = await hasSiblingScripts(uri)
            if (bundled) {
              for (const a of agents) {
                if (!a.hasBundledScripts) {
                  a.hasBundledScripts = true
                  a.issues = [
                    ...a.issues,
                    'Bundles executable scripts — review before trusting (never executed by discovery).',
                  ]
                }
              }
            }
          }

          all.push(...agents)
        }
      }
    }
  }

  return all
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

/** List (never run) sibling files of a SKILL.md to detect bundled scripts. */
async function hasSiblingScripts(skillUri: vscode.Uri): Promise<boolean> {
  try {
    const dir = vscode.Uri.joinPath(skillUri, '..')
    const entries = await vscode.workspace.fs.readDirectory(dir)
    return entries.some(
      ([name, kind]) => kind === vscode.FileType.File && SCRIPT_EXTENSIONS.test(name),
    )
  } catch {
    return false
  }
}
