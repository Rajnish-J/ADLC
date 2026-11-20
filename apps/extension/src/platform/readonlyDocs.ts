// Read-only Markdown documents for platform content (an agent's instructions, a memory item), opened in the
// Markdown preview without creating dirty untitled editors.

import * as vscode from 'vscode'

const SCHEME = 'sdlc-platform'
const contents = new Map<string, string>()
const changed = new vscode.EventEmitter<vscode.Uri>()

export function registerReadonlyDocs(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    changed,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: changed.event,
      provideTextDocumentContent: (uri) => contents.get(uri.toString()) ?? '',
    }),
  )
}

/** Show `markdown` as a read-only preview. `path` names the document, e.g. `PAY/agents/planner.md`. */
export async function showReadonlyMarkdown(path: string, markdown: string): Promise<void> {
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${path}` })
  contents.set(uri.toString(), markdown)
  changed.fire(uri)
  await vscode.commands.executeCommand('markdown.showPreview', uri)
}
