// The Stories view: stories assigned to you, then every project you can see — its project memory (accepted
// knowledge, plus proposals to accept or reject) and its stories in board order. Data comes from the SDLC
// platform API — the same projects, stories and memory the web app shows.
//
// Loading the view also syncs your assigned Azure Boards work items into stories (the platform throttles it), so
// what is assigned to you in Azure DevOps shows up here and on the web; a project that can't sync shows why.

import * as vscode from 'vscode'
import {
  MEMORY_KIND_LABELS,
  PROJECT_ROLE_LABELS,
  can,
  harnessLabel,
  type Me,
  type Permission,
  type MemoryItem,
  type MemoryKind,
  type ProjectProfileState,
  type ProjectSummary,
  type BoardsSyncResult,
  type Story,
  type StoryStatus,
} from '@sdlc/contracts'
import type { PlatformClient } from './platformClient'
import { syncMyStories } from './boardsClient'
import { compareStories, isOverdue, statusLabel, storyContextValue, storyTagLine } from './storyFormat'

export type PlatformNode =
  | { kind: 'mine' }
  | { kind: 'project'; project: ProjectSummary }
  | { kind: 'story'; story: Story }
  | { kind: 'memory'; project: ProjectSummary }
  | { kind: 'memoryProposed'; project: ProjectSummary; items: MemoryItem[] }
  | { kind: 'memoryItem'; project: ProjectSummary; item: MemoryItem }
  | { kind: 'profile'; project: ProjectSummary; state: ProjectProfileState }
  | { kind: 'message'; text: string; error?: boolean }

const MEMORY_ICON: Record<MemoryKind, string> = {
  note: 'note',
  decision: 'law',
  convention: 'checklist',
  learning: 'lightbulb',
  summary: 'list-flat',
}

/** Pinned first, then most recently updated. */
const byPinnedThenRecent = (a: MemoryItem, b: MemoryItem) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)

const STATUS_ICON: Record<StoryStatus, vscode.ThemeIcon> = {
  draft: new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('disabledForeground')),
  ready: new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('charts.blue')),
  in_progress: new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.yellow')),
  in_review: new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.purple')),
  done: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')),
}

function storyTooltip(story: Story): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true)
  md.appendMarkdown(`**${story.key}** · ${statusLabel(story.status)} · ${story.priority}\n\n`)
  if (story.external) md.appendMarkdown(`$(link-external) [Azure DevOps #${story.external.id}](${story.external.url}) · ${story.external.type} · ${story.external.state}\n\n`)
  md.appendMarkdown(`### ${story.title}\n\n`)
  if (story.isBlocked) md.appendMarkdown(`$(error) **Blocked**${story.blockedReason ? `: ${story.blockedReason}` : ''}\n\n`)
  if (story.labels.length) md.appendMarkdown(`$(tag) ${story.labels.map((l) => `\`${l}\``).join(' ')}\n\n`)
  if (story.dueDate) md.appendMarkdown(`$(calendar) Due ${story.dueDate}${isOverdue(story, today()) ? ' — **overdue**' : ''}\n\n`)
  if (story.description) md.appendText(`${story.description}\n\n`)
  if (story.acceptanceCriteria.length > 0) {
    md.appendMarkdown('**Acceptance criteria**\n\n')
    for (const c of story.acceptanceCriteria) md.appendMarkdown(`- ${c.met ? '$(check)' : '$(circle-large-outline)'} ${c.text}\n`)
  }
  md.appendMarkdown(`\n\n${story.assignee ? `Assigned to ${story.assignee.displayName}` : 'Unassigned'}`)
  const run = story.latestRun
  if (run?.workflowName) {
    md.appendMarkdown(`\n\n$(play-circle) Last run: **${run.workflowName}** — ${run.status.replace(/_/g, ' ')}${run.engine ? ` in ${harnessLabel(run.engine)}` : ''}`)
  }
  return md
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export class PlatformStoriesProvider implements vscode.TreeDataProvider<PlatformNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PlatformNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private client: PlatformClient | undefined
  private me: Me | undefined
  /** Projects whose last Azure Boards sync failed (shown as warning rows). */
  private syncErrors: BoardsSyncResult[] = []
  private lastSyncAt = 0
  private syncing: Promise<void> | undefined

  /** Point the view at a backend (undefined = disconnected; the welcome view offers Connect). */
  setClient(client: PlatformClient | undefined): void {
    this.client = client
    this.me = undefined
    this.syncErrors = []
    this.lastSyncAt = 0
    this.refresh()
  }

  /**
   * Sync my assigned Azure Boards work items into stories, then refresh when anything changed. Runs at most once a
   * minute from loading the view (the API throttles too); `force` (the Sync command) always runs. Returns the
   * per-project results for the caller to report (undefined when skipped, throttled or unavailable).
   */
  async syncBoards(force = false): Promise<BoardsSyncResult[] | undefined> {
    const client = this.client
    if (!client) return undefined
    if (!force && (this.syncing || Date.now() - this.lastSyncAt < 60_000)) return undefined
    this.lastSyncAt = Date.now()
    let results: BoardsSyncResult[] | undefined
    const run = (async () => {
      try {
        const res = await syncMyStories(client, force)
        if (res.throttled || client !== this.client) return
        results = res.results
        const key = (rs: BoardsSyncResult[]) => rs.map((r) => `${r.projectKey}:${r.error}`).join('|')
        const before = key(this.syncErrors)
        this.syncErrors = res.results.filter((r) => r.error)
        if (res.results.some((r) => r.created > 0 || r.updated > 0) || before !== key(this.syncErrors)) this.refresh()
      } catch (err) {
        if (force) throw err
        /* an older API without the sync, or offline — the stories still load */
      }
    })()
    this.syncing = run
    try {
      await run
    } finally {
      if (this.syncing === run) this.syncing = undefined
    }
    return results
  }

  get currentUser(): Me | undefined {
    return this.me
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  /** Client-side hint only (the API enforces it): may the signed-in user do `perm` in this project? */
  private may(project: ProjectSummary, perm: Permission): boolean {
    const me = this.me
    return Boolean(me && can({ userId: me.user.id, orgRole: me.user.orgRole }, project.myRole ?? undefined, perm))
  }

  getTreeItem(node: PlatformNode): vscode.TreeItem {
    switch (node.kind) {
      case 'mine': {
        const item = new vscode.TreeItem('Assigned to me', vscode.TreeItemCollapsibleState.Expanded)
        item.iconPath = new vscode.ThemeIcon('account')
        item.contextValue = 'platformMine'
        return item
      }
      case 'project': {
        const p = node.project
        const item = new vscode.TreeItem(`${p.key} — ${p.name}`, vscode.TreeItemCollapsibleState.Collapsed)
        item.description = p.myRole ? PROJECT_ROLE_LABELS[p.myRole] : 'Admin access'
        const repo = p.repository ? `\n\nRepository: ${p.repository.displayName} (${p.repository.status})` : '\n\nNo repository linked'
        item.tooltip = `${p.name}\n${p.description}\n\nReady ${p.storyCounts.ready} · In progress ${p.storyCounts.in_progress} · In review ${p.storyCounts.in_review}${repo}`
        item.iconPath = new vscode.ThemeIcon('project')
        // `:repo` when a repository is linked (Clone / Open Repository).
        item.contextValue = `platformProject${p.repository ? ':repo' : ''}${this.may(p, 'story.create') ? ':create' : ''}`
        return item
      }
      case 'story': {
        const s = node.story
        const item = new vscode.TreeItem(`${s.key}  ${s.title}`, vscode.TreeItemCollapsibleState.None)
        const who = s.assignee ? s.assignee.displayName : s.actions.canPickUp ? 'ready to pick up' : 'unassigned'
        const tags = storyTagLine(s)
        const overdue = isOverdue(s, today()) ? ' · overdue' : ''
        const ado = s.external ? ` · ADO #${s.external.id} ${s.external.state}` : ''
        // The workflow the story's latest run used (a workflow is picked when a run starts, not ahead of time).
        const flow = s.latestRun?.workflowName ? ` · ⚙ ${s.latestRun.workflowName}` : ''
        item.description = `${statusLabel(s.status)} · ${who}${s.isBlocked ? ' · blocked' : ''}${overdue}${ado}${flow}${tags ? ` · ${tags}` : ''}`
        item.tooltip = storyTooltip(s)
        item.iconPath = s.isBlocked ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')) : STATUS_ICON[s.status]
        // `:ado` when synced from Azure Boards (Open in Azure DevOps).
        item.contextValue = `${storyContextValue(s, this.me?.user.id)}${s.external ? ':ado' : ''}`
        item.command = { command: 'sdlcGovernance.platform.openStory', title: 'Open Story', arguments: [node] }
        return item
      }
      case 'memory': {
        const item = new vscode.TreeItem('Project memory', vscode.TreeItemCollapsibleState.Collapsed)
        item.tooltip = 'Decisions, conventions and learnings agents get as context — the same as the web app’s Memory page'
        item.iconPath = new vscode.ThemeIcon('book')
        // `:add` when the user may add accepted project memory directly (memory.curate).
        item.contextValue = `platformMemoryRoot${this.may(node.project, 'memory.curate') ? ':add' : ''}`
        return item
      }
      case 'memoryProposed': {
        const item = new vscode.TreeItem('Proposed', vscode.TreeItemCollapsibleState.Expanded)
        item.description = `${node.items.length} awaiting review`
        item.iconPath = new vscode.ThemeIcon('inbox', new vscode.ThemeColor('notificationsWarningIcon.foreground'))
        return item
      }
      case 'memoryItem': {
        const m = node.item
        const item = new vscode.TreeItem(m.title, vscode.TreeItemCollapsibleState.None)
        const from = m.storyKey ? `from ${m.storyKey}` : undefined
        item.description = [MEMORY_KIND_LABELS[m.kind], m.pinned ? 'pinned' : undefined, from].filter(Boolean).join(' · ')
        item.tooltip = new vscode.MarkdownString(`**${m.title}**

${m.content.slice(0, 800)}`)
        item.iconPath = new vscode.ThemeIcon(m.pinned ? 'pinned' : MEMORY_ICON[m.kind])
        // `:decide` / `:archive` drive the inline actions (the API re-checks permissions).
        // `:pin` / `:unpin` for curators on accepted items.
        const pin = m.status === 'accepted' && m.actions.canPin ? (m.pinned ? ':unpin' : ':pin') : ''
        const flags = [m.status === 'proposed' && m.actions.canDecide ? ':decide' : '', m.status !== 'archived' && m.actions.canArchive ? ':archive' : '', pin]
        item.contextValue = `platformMemory${flags.join('')}`
        item.command = { command: 'sdlcGovernance.platform.openMemoryItem', title: 'Open Memory Item', arguments: [node] }
        return item
      }
      case 'profile': {
        const { current, pending, canGenerate } = node.state
        const item = new vscode.TreeItem('Project profile', vscode.TreeItemCollapsibleState.None)
        const status =
          pending?.status === 'generating'
            ? 'generating…'
            : pending?.status === 'proposed'
              ? `update from ${pending.runIds.length} run${pending.runIds.length === 1 ? '' : 's'} to review`
              : pending?.status === 'failed'
                ? 'generation failed'
                : undefined
        const version = current ? `v${current.version}${current.branch ? ` · ${current.branch}` : ''}` : 'not generated yet'
        item.description = [version, status].filter(Boolean).join(' · ')
        item.tooltip = new vscode.MarkdownString(
          current?.content
            ? `**${current.content.headline}**

Written by the built-in Project profiler from the repository and given to every agent run.`
            : 'What the project is, its stack, architecture, status, developer guide and integrations — written by the built-in Project profiler from the linked repository.',
        )
        item.iconPath =
          pending?.status === 'generating'
            ? new vscode.ThemeIcon('loading~spin')
            : pending?.status === 'proposed'
              ? new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('notificationsWarningIcon.foreground'))
              : new vscode.ThemeIcon('sparkle')
        // `:open` when there is something to read, `:generate` for curators (repo linked), `:decide` for a proposal.
        const flags = [
          current?.content || pending?.content ? ':open' : '',
          canGenerate && node.state.hasRepository && pending?.status !== 'generating' ? ':generate' : '',
          pending?.status === 'proposed' && pending.actions.canDecide ? ':decide' : '',
        ]
        item.contextValue = `platformProfile${flags.join('')}`
        if (current?.content || pending?.content) item.command = { command: 'sdlcGovernance.platform.openProjectProfile', title: 'Open Project Profile', arguments: [node] }
        return item
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None)
        item.iconPath = new vscode.ThemeIcon(node.error ? 'warning' : 'info')
        return item
      }
    }
  }

  async getChildren(node?: PlatformNode): Promise<PlatformNode[]> {
    const client = this.client
    if (!client) return []
    try {
      if (!node) {
        this.me = await client.me()
        // First load (and at most once a minute after): bring in what is assigned to me in Azure Boards. Not awaited —
        // the view refreshes itself when the sync creates or changes stories.
        void this.syncBoards()
        const [projects, mine] = await Promise.all([client.projects(), client.myStories()])
        const roots: PlatformNode[] = []
        for (const r of this.syncErrors) roots.push({ kind: 'message', text: `${r.projectKey}: Azure Boards sync — ${r.error}`, error: true })
        if (mine.length > 0) roots.push({ kind: 'mine' })
        roots.push(...projects.map((project): PlatformNode => ({ kind: 'project', project })))
        if (projects.length === 0) roots.push({ kind: 'message', text: 'You are not a member of any project yet.' })
        return roots
      }
      if (node.kind === 'mine') {
        const mine = await client.myStories()
        return mine.sort(compareStories).map((story): PlatformNode => ({ kind: 'story', story }))
      }
      if (node.kind === 'project') {
        const stories = await client.stories(node.project.key)
        const memory: PlatformNode = { kind: 'memory', project: node.project }
        if (stories.length === 0) return [memory, { kind: 'message', text: 'No stories yet.' }]
        return [memory, ...stories.sort(compareStories).map((story): PlatformNode => ({ kind: 'story', story }))]
      }
      if (node.kind === 'memory') {
        const [items, profile] = await Promise.all([client.projectMemory(node.project.key), client.projectProfile(node.project.key).catch(() => null)])
        const project = node.project
        const proposed = items.filter((m) => m.status === 'proposed').sort(byPinnedThenRecent)
        const accepted = items.filter((m) => m.status === 'accepted').sort(byPinnedThenRecent)
        const rows: PlatformNode[] = []
        if (profile) rows.push({ kind: 'profile', project, state: profile })
        if (proposed.length) rows.push({ kind: 'memoryProposed', project, items: proposed })
        rows.push(...accepted.map((item): PlatformNode => ({ kind: 'memoryItem', project, item })))
        return rows.length ? rows : [{ kind: 'message', text: 'No project memory yet.' }]
      }
      if (node.kind === 'memoryProposed') {
        return node.items.map((item): PlatformNode => ({ kind: 'memoryItem', project: node.project, item }))
      }
      return []
    } catch (err) {
      return [{ kind: 'message', text: err instanceof Error ? err.message : String(err), error: true }]
    }
  }
}
