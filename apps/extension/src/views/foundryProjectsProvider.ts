// Foundry Projects tree (T4).
//
// Lists the Foundry projects the signed-in identity can access (RBAC-scoped),
// fetched live from ARM/Cognitive APIs via foundryClient. Each project expands
// to show its account, resource group, and data-plane endpoint — proving the
// harvested connection pipeline works inside the extension host.

import * as vscode from 'vscode'
import { getToken, isSignedIn } from '../auth/azureAuth'
import { ARM_SCOPE } from '../foundry/constants'
import { listAllAccessibleProjectsDetailed, type FoundryDiscoveryDiagnostics } from '../foundry/foundryClient'
import type { FoundryProject } from '../foundry/types'

/** Turns the walk's diagnostic counters into a specific empty-state message — distinguishing "no
 * subscriptions" from "RBAC blocked resource-group reads" from "no AIServices resource" from "resource(s)
 * found but no projects under them", instead of one flat "no accessible projects" message. */
function emptyStateMessage(d: FoundryDiscoveryDiagnostics): string {
  if (d.subscriptionCount === 0) {
    return 'No Azure subscriptions are accessible to this account.'
  }
  if (d.readableSubscriptionCount === 0) {
    return "Signed in, but couldn't read resource groups in any subscription — check the account has at least Reader access."
  }
  if (d.aiServicesAccountCount === 0) {
    return 'No Azure AI Foundry resource (kind: AIServices) found in your accessible subscriptions.'
  }
  return `Found ${d.aiServicesAccountCount} Foundry resource(s) but no projects under them.`
}

type Node = ProjectNode | DetailNode | MessageNode

class ProjectNode extends vscode.TreeItem {
  constructor(public readonly project: FoundryProject) {
    super(project.displayName, vscode.TreeItemCollapsibleState.Collapsed)
    this.description = project.accountName
    this.tooltip = project.description ?? project.projectEndpoint
    this.iconPath = new vscode.ThemeIcon('project')
    this.contextValue = 'foundryProject'
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

export class FoundryProjectsProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private projects: FoundryProject[] | undefined
  private diagnostics: FoundryDiscoveryDiagnostics | undefined
  private error: string | undefined
  private loading = false

  refresh(): void {
    this.projects = undefined
    this.diagnostics = undefined
    this.error = undefined
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element instanceof ProjectNode) {
      const p = element.project
      return [
        new DetailNode('Account', p.accountName, 'cloud'),
        new DetailNode('Resource group', p.resourceGroup, 'symbol-namespace'),
        new DetailNode('Subscription', p.subscriptionId, 'key'),
        new DetailNode('Endpoint', p.projectEndpoint, 'link'),
      ]
    }
    if (element) {
      return []
    }

    // Root level.
    // When signed out, return nothing so the view's welcome (with a Sign in
    // button) shows instead of a noisy auth error.
    if (!(await isSignedIn(ARM_SCOPE))) {
      return []
    }
    if (this.loading) {
      return [new MessageNode('Loading projects…', 'loading~spin')]
    }
    if (this.error) {
      return [new MessageNode(this.error, 'error')]
    }
    if (this.projects === undefined) {
      await this.load()
      return this.getChildren()
    }
    if (this.projects.length === 0) {
      const message = this.diagnostics ? emptyStateMessage(this.diagnostics) : 'No accessible Foundry projects found.'
      return [new MessageNode(message, 'info')]
    }
    return this.projects.map((p) => new ProjectNode(p))
  }

  private async load(): Promise<void> {
    this.loading = true
    try {
      const { projects, diagnostics } = await listAllAccessibleProjectsDetailed(getToken)
      this.projects = projects
      this.diagnostics = diagnostics
      this.error = undefined
    } catch (err) {
      this.projects = []
      this.diagnostics = undefined
      this.error = err instanceof Error ? err.message : 'Failed to load Foundry projects.'
    } finally {
      this.loading = false
    }
  }
}
