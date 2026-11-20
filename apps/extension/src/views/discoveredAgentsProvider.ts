// Discovered Agents tree (Phase 2).
//
// Surfaces the normalized internal agent model grouped by source convention:
//   <Source kind>  →  <Agent>  →  <detail rows>
// Owns the discovery lifecycle: an initial scan, a manual refresh, a debounced
// re-scan driven by a FileSystemWatcher over the manifest globs, and publishing
// per-file diagnostics to the Problems panel. Mirrors the loading/error/empty
// MessageNode pattern proven in foundryProjectsProvider.ts.

import * as vscode from 'vscode'
import {
  SOURCE_LABELS,
  type InternalAgent,
  type SourceKind,
} from '../discovery/agentModel'
import { discover } from '../discovery/normalizer'
import { publishDiagnostics } from '../discovery/diagnostics'

type Node = GroupNode | AgentItemNode | DetailNode | MessageNode

class GroupNode extends vscode.TreeItem {
  constructor(
    public readonly kind: SourceKind,
    public readonly agents: InternalAgent[],
  ) {
    super(SOURCE_LABELS[kind], vscode.TreeItemCollapsibleState.Expanded)
    this.description = `${agents.length}`
    this.iconPath = new vscode.ThemeIcon('folder-library')
    this.contextValue = 'agentGroup'
  }
}

class AgentItemNode extends vscode.TreeItem {
  constructor(public readonly agent: InternalAgent, uri: vscode.Uri | undefined) {
    super(agent.name, vscode.TreeItemCollapsibleState.Collapsed)
    this.description = agent.description || agent.sourcePath
    this.tooltip = buildTooltip(agent)
    this.iconPath = statusIcon(agent)
    this.contextValue = 'discoveredAgent'
    if (uri) {
      this.command = {
        command: 'vscode.open',
        title: 'Open manifest',
        arguments: [uri],
      }
    }
  }
}

class DetailNode extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description = value
    this.tooltip = value
    this.iconPath = new vscode.ThemeIcon(icon)
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon(icon)
  }
}

export class DiscoveredAgentsProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private agents: InternalAgent[] = []
  private loading = false
  private hasScanned = false
  private debounce: ReturnType<typeof setTimeout> | undefined
  /** Set when the last scan threw, so the tree can show the real cause instead of a generic empty state. */
  private error: string | undefined

  constructor(private readonly diagnostics: vscode.DiagnosticCollection) {}

  /** Number of normalized agents from the last scan (0 before the first scan). */
  get count(): number {
    return this.agents.length
  }

  /** Whether at least one discovery pass has completed. */
  get scanned(): boolean {
    return this.hasScanned
  }

  /** Snapshot of discovered agents — safe to read from the extension host for webview serialisation. */
  getAgents(): InternalAgent[] {
    return this.agents
  }

  /** Run a full discovery pass, publish diagnostics, refresh the tree. */
  async refresh(): Promise<void> {
    this.loading = true
    this._onDidChangeTreeData.fire()
    try {
      const result = await discover()
      this.agents = result.agents
      this.error = undefined
      publishDiagnostics(this.diagnostics, this.agents)
      const merged = result.rawCount - this.agents.length
      void vscode.commands.executeCommand(
        'setContext',
        'sdlcGovernance.hasAgents',
        this.agents.length > 0,
      )
      if (merged > 0) {
        void vscode.window.setStatusBarMessage(
          `SDLC: discovered ${this.agents.length} agents (${merged} duplicate${merged === 1 ? '' : 's'} merged).`,
          4000,
        )
      }
    } catch (err) {
      // Previously swallowed entirely (only `finally` ran) — a thrown discovery error rendered as an
      // indistinguishable "no agents found" empty state. Surface it instead (see getChildren()).
      this.agents = []
      this.error = err instanceof Error ? err.message : 'Agent discovery failed.'
      void vscode.window.showErrorMessage(`SDLC: agent discovery failed: ${this.error}`)
    } finally {
      this.loading = false
      this.hasScanned = true
      this._onDidChangeTreeData.fire()
    }
  }

  /** Re-scan on a short debounce — used by the file watcher. */
  scheduleRefresh(): void {
    if (this.debounce) {
      clearTimeout(this.debounce)
    }
    this.debounce = setTimeout(() => void this.refresh(), 750)
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element
  }

  getChildren(element?: Node): Node[] {
    if (element instanceof GroupNode) {
      return element.agents.map((a) => new AgentItemNode(a, toWorkspaceUri(a.sourcePath)))
    }
    if (element instanceof AgentItemNode) {
      return detailNodes(element.agent)
    }
    if (element) {
      return []
    }

    // Root level.
    if (this.loading && !this.hasScanned) {
      return [new MessageNode('Discovering agents…', 'loading~spin')]
    }
    if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
      return [new MessageNode('Open a folder to discover agent manifests.', 'folder')]
    }
    if (this.error) {
      return [new MessageNode(this.error, 'error')]
    }
    if (this.agents.length === 0) {
      return [new MessageNode('No agent manifests found in this workspace.', 'info')]
    }

    const groups: Node[] = []
    for (const kind of Object.keys(SOURCE_LABELS) as SourceKind[]) {
      const inKind = this.agents.filter((a) => a.sourceKind === kind)
      if (inKind.length > 0) {
        groups.push(new GroupNode(kind, inKind))
      }
    }
    return groups
  }
}

function detailNodes(agent: InternalAgent): DetailNode[] {
  const nodes: DetailNode[] = [
    new DetailNode('Description', agent.description || '—', 'note'),
    new DetailNode('Source', agent.sourcePath, 'file-code'),
    new DetailNode('Status', agent.status, statusDetailIcon(agent.status)),
  ]
  if (agent.model) {
    nodes.push(new DetailNode('Model', agent.model, 'symbol-misc'))
  }
  if (agent.tools.length > 0) {
    nodes.push(new DetailNode('Tools', agent.tools.join(', '), 'tools'))
  }
  if (agent.hasBundledScripts) {
    nodes.push(new DetailNode('Bundled scripts', 'present — audit before trusting', 'warning'))
  }
  if (agent.alsoSeenIn?.length) {
    nodes.push(
      new DetailNode(
        'Also declared in',
        agent.alsoSeenIn.map((k) => SOURCE_LABELS[k]).join(', '),
        'references',
      ),
    )
  }
  for (const issue of agent.issues) {
    nodes.push(new DetailNode('Issue', issue, 'warning'))
  }
  for (const suggestion of agent.suggestions ?? []) {
    nodes.push(new DetailNode('Suggestion', suggestion.message, 'lightbulb'))
  }
  return nodes
}

function statusIcon(agent: InternalAgent): vscode.ThemeIcon {
  if (agent.status === 'skipped') {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'))
  }
  if (agent.status === 'needs-attention') {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
  }
  if (agent.hasBundledScripts) {
    return new vscode.ThemeIcon('shield')
  }
  if (agent.suggestions?.length) {
    return new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('problemsInfoIcon.foreground'))
  }
  return new vscode.ThemeIcon('robot')
}

function statusDetailIcon(status: InternalAgent['status']): string {
  return status === 'valid' ? 'pass' : status === 'needs-attention' ? 'warning' : 'error'
}

function buildTooltip(agent: InternalAgent): string {
  const lines = [`${agent.name} — ${SOURCE_LABELS[agent.sourceKind]}`, agent.sourcePath]
  if (agent.issues.length) {
    lines.push('', ...agent.issues.map((i) => `• ${i}`))
  }
  if (agent.suggestions?.length) {
    lines.push('', `Suggestions (${agent.suggestions.length}):`, ...agent.suggestions.map((s) => `💡 ${s.message}`))
  }
  return lines.join('\n')
}

/** Resolve a workspace-relative POSIX path back to an absolute Uri. */
function toWorkspaceUri(relPath: string): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) {
    return undefined
  }
  if (folders.length === 1) {
    return vscode.Uri.joinPath(folders[0].uri, relPath)
  }
  const [first, ...rest] = relPath.split('/')
  const match = folders.find((f) => f.name === first)
  return match
    ? vscode.Uri.joinPath(match.uri, rest.join('/'))
    : vscode.Uri.joinPath(folders[0].uri, relPath)
}
