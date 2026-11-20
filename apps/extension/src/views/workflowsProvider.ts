// Workflows sidebar tree view.
//
// Flat list of the built-in workflows — the same two the SDLC platform seeds into every project, served in-memory
// and read-only by WorkflowStore: "Story delivery" (the default, pinned first) and "Quick fix".
//
// Context values drive the "when" clauses for context-menu commands in package.json.

import * as vscode from 'vscode'
import type { WorkflowStore, WorkflowEntry } from '../runtime/workflowStore'

type ItemKind = 'header' | 'default-workflow' | 'user-workflow'

export class WorkflowItem extends vscode.TreeItem {
  constructor(
    public readonly entry: WorkflowEntry | null,
    kind: ItemKind,
  ) {
    const label =
      kind === 'header'
        ? entry === null
          ? 'Story delivery'
          : 'My Workflows'
        : (entry?.name ?? '')

    super(
      label,
      kind === 'header'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    )

    this.contextValue = kind

    if (kind === 'default-workflow' && entry) {
      this.description = entry.isDefault ? 'default · read-only' : 'built-in · read-only'
      this.tooltip = entry.description || 'Built-in default workflow — duplicate to customise'
      this.iconPath = new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.orange'))
      this.command = {
        command: 'sdlcGovernance.openWorkflowBuilder',
        title: 'Open',
        arguments: [entry.id, true],
      }
    } else if (kind === 'user-workflow' && entry) {
      this.description = entry.description || ''
      this.tooltip = entry.description || entry.name
      this.iconPath = new vscode.ThemeIcon('workflow')
      this.command = {
        command: 'sdlcGovernance.openWorkflowBuilder',
        title: 'Open',
        arguments: [entry.id, false],
      }
    } else {
      // header
      this.iconPath =
        entry === null
          ? new vscode.ThemeIcon('shield', new vscode.ThemeColor('charts.orange'))
          : new vscode.ThemeIcon('files')
    }
  }
}

export class WorkflowsProvider implements vscode.TreeDataProvider<WorkflowItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WorkflowItem | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly store: WorkflowStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: WorkflowItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: WorkflowItem): Promise<WorkflowItem[]> {
    // Flat list: the locked default (lock icon, pinned first by listAll()) followed by
    // user-created / duplicated workflows.
    if (element) return []
    const entries = await this.store.listAll()
    return entries.map((e) => new WorkflowItem(e, e.isDefault || e.builtin ? 'default-workflow' : 'user-workflow'))
  }
}
