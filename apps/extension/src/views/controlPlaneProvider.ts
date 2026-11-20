// Phase 5B — Control Plane "Compliance" pane.
//
// Shows the registered agent fleet for the first accessible Foundry project, grouped by compliance
// against the active guardrail policy, and drives single + bulk remediation. Because the server-side
// Foundry backend is an unresolved Phase-4 spike (Unknown A), an unreachable data plane renders an
// explicit "backend not enabled" message — never a silent empty fleet. See plan §5B.

import * as vscode from 'vscode'
import { getToken, isSignedIn } from '../auth/azureAuth'
import { ARM_SCOPE } from '../foundry/constants'
import { listAllAccessibleProjects } from '../foundry/foundryClient'
import {
  ControlPlaneClient,
  evaluateCompliance,
  type AgentCompliance,
  type GuardrailPolicy,
} from '../foundry/controlPlane'

type Node = GroupNode | AgentNode | MessageNode

class GroupNode extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly compliant: boolean,
    count: number,
  ) {
    super(`${label} (${count})`, vscode.TreeItemCollapsibleState.Expanded)
    this.iconPath = new vscode.ThemeIcon(
      compliant ? 'pass' : 'warning',
      new vscode.ThemeColor(compliant ? 'testing.iconPassed' : 'notificationsWarningIcon.foreground'),
    )
    this.contextValue = 'sdlcCompliance.group'
  }
}

export class AgentNode extends vscode.TreeItem {
  constructor(public readonly entry: AgentCompliance) {
    super(`${entry.agent.name} v${entry.agent.version}`, vscode.TreeItemCollapsibleState.None)
    this.description = entry.compliant ? 'compliant' : `missing: ${entry.missing.join(', ')}`
    this.tooltip = entry.compliant
      ? 'Meets the active guardrail policy.'
      : `Missing required guardrails:\n${entry.missing.map((m) => `  • ${m}`).join('\n')}`
    this.iconPath = new vscode.ThemeIcon(entry.compliant ? 'shield' : 'circle-slash')
    // Drives the inline "remediate" action (non-compliant agents only).
    this.contextValue = entry.compliant ? 'sdlcAgent.compliant' : 'sdlcAgent.nonCompliant'
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon(icon)
  }
}

export class ControlPlaneProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private loading = false
  private unavailableReason: string | undefined
  private client: ControlPlaneClient | undefined
  private policy: GuardrailPolicy | undefined
  private compliance: AgentCompliance[] | undefined

  refresh(): void {
    this.compliance = undefined
    this.unavailableReason = undefined
    this.client = undefined
    this.policy = undefined
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element instanceof GroupNode) {
      const list = (this.compliance ?? []).filter((c) => c.compliant === element.compliant)
      return list.map((c) => new AgentNode(c))
    }
    if (element) return []

    if (!(await isSignedIn(ARM_SCOPE))) {
      return [new MessageNode('Sign in to Azure to view the agent fleet.', 'sign-in')]
    }
    if (this.loading) return [new MessageNode('Loading Control Plane…', 'loading~spin')]
    if (this.compliance === undefined && this.unavailableReason === undefined) {
      await this.load()
    }
    if (this.unavailableReason) {
      return [
        new MessageNode('Foundry Control Plane not yet enabled (P4 backend spike pending).', 'cloud'),
        new MessageNode(this.unavailableReason, 'warning'),
      ]
    }
    if (!this.policy) {
      return [new MessageNode('No guardrail policy configured for this project.', 'info')]
    }
    const all = this.compliance ?? []
    const nonCompliant = all.filter((c) => !c.compliant).length
    return [
      new GroupNode('Non-compliant', false, nonCompliant),
      new GroupNode('Compliant', true, all.length - nonCompliant),
    ]
  }

  private async load(): Promise<void> {
    this.loading = true
    try {
      const projects = await listAllAccessibleProjects(getToken)
      if (projects.length === 0) {
        this.unavailableReason = 'No accessible Foundry projects found.'
        return
      }
      const client = new ControlPlaneClient(projects[0].projectEndpoint, getToken)
      const fleet = await client.fetchFleet()
      if (!fleet.available) {
        this.unavailableReason = fleet.reason
        return
      }
      this.client = client
      this.policy = fleet.policies[0]
      this.compliance = this.policy ? evaluateCompliance(fleet.agents, this.policy) : []
    } catch (err) {
      this.unavailableReason = err instanceof Error ? err.message : 'Control Plane load failed.'
    } finally {
      this.loading = false
    }
  }

  /** Remediate one agent against the active policy. Returns false if the Control Plane isn't ready. */
  async remediate(entry: AgentCompliance): Promise<boolean> {
    if (!this.client || !this.policy) return false
    await this.client.remediateAgent(entry.agent, this.policy)
    return true
  }

  /** Current non-compliant entries (for bulk remediation). */
  nonCompliantEntries(): AgentCompliance[] {
    return (this.compliance ?? []).filter((c) => !c.compliant)
  }

  canRemediate(): boolean {
    return this.client !== undefined && this.policy !== undefined
  }
}
