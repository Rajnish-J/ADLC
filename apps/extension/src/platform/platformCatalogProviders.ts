// The platform sections of the Agents and Workflows views: the project's agent catalog (built-ins plus agents
// and skills found in its codebase — enable/disable, locked when the user's role is too low, where each is
// mapped) and the project's workflows with the agent bound to each step. Same data the web app's Agents and
// Workflow pages show. With one project the project level is skipped.

import * as vscode from 'vscode'
import {
  PROJECT_ROLE_LABELS,
  RUN_STATUS_LABELS,
  type Agent,
  type EvaluationResult,
  type PlatformEvent,
  type ProjectRun,
  type ProjectSummary,
  type StoryRunStatus,
  type StoryRunStep,
  type WorkflowSummary,
} from '@sdlc/contracts'
import type { SpecNode, SpecNodeKind } from '@sdlc/core'
import type { PlatformClient } from './platformClient'
import { canIn, type PlatformHandle } from './platformHandle'

export type CatalogNode =
  | { kind: 'project'; project: ProjectSummary }
  | { kind: 'agent'; project: ProjectSummary; agent: Agent; usedIn: string[] }
  | { kind: 'skills'; project: ProjectSummary; skills: Agent[] }
  | { kind: 'workflow'; project: ProjectSummary; workflow: WorkflowSummary }
  | { kind: 'step'; project: ProjectSummary; workflow: WorkflowSummary; node: SpecNode; index: number }
  | { kind: 'run'; project: ProjectSummary; run: ProjectRun }
  | { kind: 'runStep'; project: ProjectSummary; run: ProjectRun; step: StoryRunStep }
  | { kind: 'evaluation'; evaluation: EvaluationResult }
  | { kind: 'message'; text: string; error?: boolean; command?: vscode.Command }

const CONNECT: vscode.Command = { command: 'sdlcGovernance.platform.connect', title: 'Connect to the SDLC Platform' }

/** "<workflow> › <step>" for every agent step, keyed by the agent slug it is bound to. */
export async function stepMappings(client: PlatformClient, projectKey: string): Promise<Map<string, string[]>> {
  const details = await Promise.all((await client.workflows(projectKey)).map((w) => client.workflow(projectKey, w.id)))
  const map = new Map<string, string[]>()
  for (const w of details) {
    for (const n of w.spec.nodes) {
      const slug = n.kind === 'agent' ? n.data.agentId : undefined
      if (slug) map.set(slug, [...(map.get(slug) ?? []), `${w.name} › ${n.label}`])
    }
  }
  return map
}

/** Shared plumbing: connection state, live refresh, and the one-project-or-many root. */
abstract class ProjectScopedProvider implements vscode.TreeDataProvider<CatalogNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<CatalogNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event
  private readonly subscriptions: vscode.Disposable[]
  private pending: ReturnType<typeof setTimeout> | undefined

  constructor(
    protected readonly platform: PlatformHandle,
    /** Which live events affect this tree. */
    relevant: (event: PlatformEvent) => boolean,
  ) {
    this.subscriptions = [
      platform.onDidChangeConnection(() => this.refresh()),
      platform.onEvent((e) => {
        if (!relevant(e)) return
        if (this.pending) clearTimeout(this.pending)
        this.pending = setTimeout(() => this.refresh(), 200)
      }),
    ]
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  protected abstract projectChildren(client: PlatformClient, project: ProjectSummary): Promise<CatalogNode[]>
  protected abstract childrenOf(client: PlatformClient, node: CatalogNode): Promise<CatalogNode[]>
  abstract getTreeItem(node: CatalogNode): vscode.TreeItem

  async getChildren(node?: CatalogNode): Promise<CatalogNode[]> {
    const client = this.platform.client()
    if (!client) return node ? [] : [{ kind: 'message', text: 'Connect to the SDLC platform to see project items', command: CONNECT }]
    try {
      if (!node) {
        const [projects] = await Promise.all([client.projects(), this.platform.ensureMe()])
        if (projects.length === 0) return [{ kind: 'message', text: 'You are not a member of any project yet.' }]
        if (projects.length === 1) return await this.projectChildren(client, projects[0])
        return projects.map((project): CatalogNode => ({ kind: 'project', project }))
      }
      if (node.kind === 'project') return await this.projectChildren(client, node.project)
      return await this.childrenOf(client, node)
    } catch (err) {
      return [{ kind: 'message', text: err instanceof Error ? err.message : String(err), error: true }]
    }
  }

  protected projectItem(project: ProjectSummary): vscode.TreeItem {
    const item = new vscode.TreeItem(`${project.key} — ${project.name}`, vscode.TreeItemCollapsibleState.Collapsed)
    item.description = project.myRole ? PROJECT_ROLE_LABELS[project.myRole] : 'Admin access'
    item.iconPath = new vscode.ThemeIcon('project')
    item.contextValue = 'platformProject'
    return item
  }

  protected messageItem(node: Extract<CatalogNode, { kind: 'message' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None)
    item.iconPath = new vscode.ThemeIcon(node.error ? 'warning' : node.command ? 'plug' : 'info')
    item.command = node.command
    return item
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending)
    for (const s of this.subscriptions) s.dispose()
    this._onDidChangeTreeData.dispose()
  }
}

// ─── Agents ─────────────────────────────────────────────────────────────────────────────────────

function agentTooltip(agent: Agent, usedIn: string[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true)
  md.appendMarkdown(`**${agent.name}** · ${agent.source === 'builtin' ? 'Built-in' : agent.source === 'platform' ? 'Platform' : `Codebase${agent.branch ? ` (${agent.branch})` : ''}`}\n\n`)
  md.appendText(`${agent.description}\n\n`)
  md.appendMarkdown(`Stage: ${agent.sdlcStage} · Runs: ${agent.executionTarget === 'local' ? 'in VS Code' : 'on the server'}\n\n`)
  if (agent.tools.length) md.appendMarkdown(`Tools: ${agent.tools.map((t) => `\`${t}\``).join(', ')}\n\n`)
  if (agent.requiredRole) md.appendMarkdown(`$(shield) ${PROJECT_ROLE_LABELS[agent.requiredRole]} or above${agent.usable ? '' : ' — locked for you'}\n\n`)
  md.appendMarkdown(usedIn.length ? `Used in: ${usedIn.join(', ')}` : 'Not mapped to any workflow step')
  return md
}

export class PlatformAgentsProvider extends ProjectScopedProvider {
  constructor(platform: PlatformHandle) {
    super(platform, (e) => e.type === 'project.changed' && (e.action === 'agents' || e.action === 'workflows'))
  }

  protected async projectChildren(client: PlatformClient, project: ProjectSummary): Promise<CatalogNode[]> {
    const [agents, mappings] = await Promise.all([client.agents(project.key), stepMappings(client, project.key)])
    if (agents.length === 0) return [{ kind: 'message', text: 'No agents yet — the platform’s built-ins are added by its seed.' }]
    const byEnabledThenName = (a: Agent, b: Agent) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)
    const nodes: CatalogNode[] = agents
      .filter((a) => a.kind === 'agent')
      .sort(byEnabledThenName)
      .map((agent) => ({ kind: 'agent', project, agent, usedIn: mappings.get(agent.slug) ?? [] }))
    const skills = agents.filter((a) => a.kind === 'skill').sort(byEnabledThenName)
    if (skills.length) nodes.push({ kind: 'skills', project, skills })
    return nodes
  }

  protected async childrenOf(_client: PlatformClient, node: CatalogNode): Promise<CatalogNode[]> {
    if (node.kind !== 'skills') return []
    return node.skills.map((agent): CatalogNode => ({ kind: 'agent', project: node.project, agent, usedIn: [] }))
  }

  getTreeItem(node: CatalogNode): vscode.TreeItem {
    switch (node.kind) {
      case 'project':
        return this.projectItem(node.project)
      case 'skills': {
        const item = new vscode.TreeItem('Skills', vscode.TreeItemCollapsibleState.Collapsed)
        item.description = `${node.skills.length}`
        item.iconPath = new vscode.ThemeIcon('sparkle')
        return item
      }
      case 'agent': {
        const { agent, usedIn } = node
        const item = new vscode.TreeItem(agent.name, vscode.TreeItemCollapsibleState.None)
        const parts = [agent.enabled ? undefined : 'off', agent.sdlcStage, usedIn.length ? `→ ${usedIn.map((u) => u.split(' › ').pop()).join(', ')}` : undefined]
        item.description = parts.filter(Boolean).join(' · ')
        item.tooltip = agentTooltip(agent, usedIn)
        item.iconPath = !agent.usable
          ? new vscode.ThemeIcon('lock', new vscode.ThemeColor('disabledForeground'))
          : agent.enabled
            ? new vscode.ThemeIcon(agent.kind === 'skill' ? 'sparkle' : 'robot', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'))
        // `:enable` / `:disable` drive the inline toggle; absent when the user can't change it.
        const canToggle = agent.usable && canIn(this.platform, node.project, 'agent.configure')
        item.contextValue = `platformAgent${canToggle ? (agent.enabled ? ':disable' : ':enable') : ''}`
        item.command = { command: 'sdlcGovernance.platform.openAgent', title: 'Open Agent', arguments: [node] }
        return item
      }
      case 'message':
        return this.messageItem(node)
      default:
        return new vscode.TreeItem('')
    }
  }
}

// ─── Workflows ──────────────────────────────────────────────────────────────────────────────────

const STEP_ICON: Partial<Record<SpecNodeKind, string>> = {
  trigger: 'debug-start',
  agent: 'robot',
  gate: 'shield',
  approval: 'person',
  condition: 'git-compare',
  end: 'pass',
}

export class PlatformWorkflowsProvider extends ProjectScopedProvider {
  constructor(platform: PlatformHandle) {
    super(platform, (e) => e.type === 'project.changed' && (e.action === 'workflows' || e.action === 'agents'))
  }

  protected async projectChildren(client: PlatformClient, project: ProjectSummary): Promise<CatalogNode[]> {
    const workflows = await client.workflows(project.key)
    if (workflows.length === 0) return [{ kind: 'message', text: 'This project has no workflows yet.' }]
    return workflows.map((workflow): CatalogNode => ({ kind: 'workflow', project, workflow }))
  }

  protected async childrenOf(client: PlatformClient, node: CatalogNode): Promise<CatalogNode[]> {
    if (node.kind !== 'workflow') return []
    const detail = await client.workflow(node.project.key, node.workflow.id)
    return detail.spec.nodes.map((n, index): CatalogNode => ({ kind: 'step', project: node.project, workflow: node.workflow, node: n, index }))
  }

  getTreeItem(node: CatalogNode): vscode.TreeItem {
    switch (node.kind) {
      case 'project':
        return this.projectItem(node.project)
      case 'workflow': {
        const w = node.workflow
        const item = new vscode.TreeItem(w.name, w.isDefault ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
        item.description = `${w.isDefault ? 'default · ' : ''}v${w.version}`
        item.tooltip = w.description || w.name
        item.iconPath = new vscode.ThemeIcon('type-hierarchy-sub')
        item.contextValue = 'platformWorkflow'
        // Click opens it in the canvas with its agent mapping (the same view as the web's Workflow page).
        item.command = { command: 'sdlcGovernance.platform.openWorkflow', title: 'Open in Canvas', arguments: [node] }
        // Version in the id so a remap (version bump) re-renders the steps instead of reusing stale ones.
        item.id = `platform-workflow:${node.project.key}:${w.id}:${w.version}`
        return item
      }
      case 'step': {
        const n = node.node
        const item = new vscode.TreeItem(`${node.index + 1}. ${n.label}`, vscode.TreeItemCollapsibleState.None)
        item.iconPath = new vscode.ThemeIcon(STEP_ICON[n.kind] ?? 'symbol-misc')
        if (n.kind === 'agent') {
          const agentName = n.data.agentName ?? n.data.agentId
          item.description = agentName ?? 'no agent assigned'
          item.tooltip = agentName ? `${n.label} runs ${agentName} (${n.data.agentId})` : `${n.label} has no agent yet`
          if (!agentName) item.iconPath = new vscode.ThemeIcon('robot', new vscode.ThemeColor('notificationsWarningIcon.foreground'))
          item.contextValue = `platformStep.agent${canIn(this.platform, node.project, 'workflow.edit') ? ':edit' : ''}`
        } else {
          item.description = n.kind
          item.contextValue = 'platformStep'
        }
        return item
      }
      case 'message':
        return this.messageItem(node)
      default:
        return new vscode.TreeItem('')
    }
  }
}

// ─── Project runs ───────────────────────────────────────────────────────────────────────────────
// Every agent run reported in the project — all stories, all developers, this window's included — newest first,
// the same list as the web app's Workflow › Runs tab. Run → steps → evaluator scores behind each gate.

const RUN_ICON: Record<StoryRunStatus, vscode.ThemeIcon> = {
  requested: new vscode.ThemeIcon('watch'),
  queued: new vscode.ThemeIcon('clock'),
  running: new vscode.ThemeIcon('sync~spin'),
  awaiting_approval: new vscode.ThemeIcon('person', new vscode.ThemeColor('notificationsWarningIcon.foreground')),
  completed: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
  failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
  cancelled: new vscode.ThemeIcon('circle-slash'),
  expired: new vscode.ThemeIcon('history'),
}

const PROJECT_RUNS_SHOWN = 30

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

export class PlatformRunsProvider extends ProjectScopedProvider {
  constructor(platform: PlatformHandle) {
    // A run report arrives as work.changed (kind 'run'); runs requested from the web as run.requested.
    super(platform, (e) => (e.type === 'work.changed' && e.kind === 'run') || e.type === 'run.requested')
  }

  protected async projectChildren(client: PlatformClient, project: ProjectSummary): Promise<CatalogNode[]> {
    const runs = await client.projectRuns(project.key, PROJECT_RUNS_SHOWN)
    if (runs.length === 0) return [{ kind: 'message', text: 'No runs yet — start a workflow on a story.' }]
    return runs.map((run): CatalogNode => ({ kind: 'run', project, run }))
  }

  protected async childrenOf(client: PlatformClient, node: CatalogNode): Promise<CatalogNode[]> {
    if (node.kind === 'run') {
      const detail = await client.projectRun(node.project.key, node.run.id)
      if (detail.steps.length === 0) return [{ kind: 'message', text: 'No steps reported yet.' }]
      return [...detail.steps].sort((a, b) => a.seq - b.seq).map((step): CatalogNode => ({ kind: 'runStep', project: node.project, run: node.run, step }))
    }
    if (node.kind === 'runStep') return node.step.evaluations.map((evaluation): CatalogNode => ({ kind: 'evaluation', evaluation }))
    return []
  }

  getTreeItem(node: CatalogNode): vscode.TreeItem {
    switch (node.kind) {
      case 'project':
        return this.projectItem(node.project)
      case 'run': {
        const r = node.run
        const label = r.story ? `${r.story.key} · ${r.workflowName}` : r.workflowName
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed)
        const gates = r.gatesPassed + r.gatesFailed ? `gates ${r.gatesPassed}/${r.gatesPassed + r.gatesFailed}` : undefined
        item.description = [RUN_STATUS_LABELS[r.status], r.startedBy?.displayName, gates, ago(r.startedAt)].filter(Boolean).join(' · ')
        const md = new vscode.MarkdownString(undefined, true)
        md.appendMarkdown(`**${r.workflowName}** — ${RUN_STATUS_LABELS[r.status]}\n\n`)
        if (r.story) md.appendText(`${r.story.key}: ${r.story.title}\n\n`)
        md.appendText(`Started ${new Date(r.startedAt).toLocaleString()}${r.startedBy ? ` by ${r.startedBy.displayName}` : ''}${r.engine ? ` in ${r.engine}` : ''}\n\n`)
        md.appendText(`${r.stepCount} steps · ${r.gatesPassed} gates passed · ${r.gatesFailed} failed`)
        if (r.agentsUsed.length) md.appendText(`\nAgents: ${r.agentsUsed.join(', ')}`)
        if (r.pendingApproval) md.appendMarkdown(`\n\n$(person) Waiting for approval: ${r.pendingApproval.question}`)
        if (r.error) md.appendMarkdown(`\n\n$(error) ${r.error}`)
        item.tooltip = md
        item.iconPath = RUN_ICON[r.status]
        item.contextValue = `platformRun${r.story ? ':story' : ''}`
        // Status in the id so a finished run re-renders (and reloads its steps) instead of reusing stale ones.
        item.id = `platform-run:${node.project.key}:${r.id}:${r.status}:${r.stepCount}`
        return item
      }
      case 'runStep': {
        const s = node.step
        const hasEvals = s.evaluations.length > 0
        const item = new vscode.TreeItem(s.label, hasEvals ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
        const verdict = s.gatePass === null ? undefined : s.gatePass ? 'gate passed' : 'gate failed'
        item.description = [s.agentName ?? undefined, s.status, verdict].filter(Boolean).join(' · ')
        item.tooltip = s.error ?? s.gateReason ?? s.output?.slice(0, 500) ?? s.label
        item.iconPath =
          s.status === 'failed' || s.gatePass === false
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
            : s.status === 'succeeded'
              ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
              : s.status === 'running'
                ? new vscode.ThemeIcon('sync~spin')
                : new vscode.ThemeIcon(s.status === 'blocked' ? 'person' : 'circle-outline')
        if (s.reportUrl) item.command = { command: 'vscode.open', title: 'Open Evaluation Report', arguments: [vscode.Uri.parse(s.reportUrl)] }
        return item
      }
      case 'evaluation': {
        const e = node.evaluation
        const item = new vscode.TreeItem(e.evaluator, vscode.TreeItemCollapsibleState.None)
        const score = e.score === null ? 'no score' : `${e.score}${e.threshold === null ? '' : ` / ${e.threshold}`}`
        item.description = `${score} · ${e.pass ? 'pass' : 'fail'}${e.required === false ? ' (advisory)' : ''}`
        item.tooltip = e.reason ?? undefined
        item.iconPath = e.pass ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('close', new vscode.ThemeColor('testing.iconFailed'))
        return item
      }
      case 'message':
        return this.messageItem(node)
      default:
        return new vscode.TreeItem('')
    }
  }
}
