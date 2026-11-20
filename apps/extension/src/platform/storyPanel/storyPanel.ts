// The Story panel: one platform story inside VS Code — overview and actions, its memory (and the project's), and
// the code activity reported on it (who is working now, commits with diffs, agent runs). The same data the web
// app's story page shows, refreshed live from the platform's event stream.

import { randomUUID } from 'crypto'
import * as vscode from 'vscode'
import { describeStoryActivity, type AuditEntry, type PlatformEvent, type Story, type User } from '@sdlc/contracts'
import { PlatformError, type PlatformClient } from '../platformClient'
import type { TrackingState } from '../work/codeActivityTracker'
import { storyBranchName } from '../storyFormat'
import {
  diffKey,
  type ActivityLine,
  type AssignableMember,
  type HostToStory,
  type PanelTracking,
  type StoryEdit,
  type StoryPanelData,
  type StoryToHost,
} from './storyPanelMessages'

const ACTIVITY_PAGE = 50
const CLIENT_LABEL: Record<string, string> = { extension: 'VS Code', web: 'Web' }

function activityLines(entries: AuditEntry[]): ActivityLine[] {
  return entries.map((e) => ({
    id: e.id,
    actor: e.actor?.displayName ?? null,
    text: describeStoryActivity(e),
    via: e.via === 'web' ? null : (CLIENT_LABEL[e.via] ?? e.via),
    createdAt: e.createdAt,
  }))
}

/** New acceptance criteria arrive from the webview without an id; give them one. */
function withCriterionIds(edit: StoryEdit): StoryEdit {
  if (!edit.acceptanceCriteria) return edit
  return { ...edit, acceptanceCriteria: edit.acceptanceCriteria.map((c) => (c.id ? c : { ...c, id: randomUUID() })) }
}

export interface StoryPanelDeps {
  extensionUri: vscode.Uri
  client: () => PlatformClient | undefined
  me: () => User | undefined
  tracking: () => TrackingState
  onPlatformEvent: vscode.Event<PlatformEvent>
  onTrackingChange: vscode.Event<TrackingState>
  /** Runs a story command (pick up, start workflow, …) the same way the tree's context menu does. */
  runStoryCommand: (command: string, story: Story) => Thenable<unknown>
  log: (message: string) => void
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
  return out
}

const COMMANDS = {
  pickUp: 'sdlcGovernance.platform.pickUp',
  startWorkflow: 'sdlcGovernance.platform.startWorkflow',
  copyBranch: 'sdlcGovernance.platform.copyBranchName',
  createBranch: 'sdlcGovernance.platform.createBranch',
  openInBrowser: 'sdlcGovernance.platform.openInBrowser',
} as const

export class StoryPanel {
  private static readonly panels = new Map<string, StoryPanel>()

  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []
  private story: Story | undefined
  private projectQuery = ''
  private reloadTimer: ReturnType<typeof setTimeout> | undefined
  private loading: Promise<void> | undefined

  /** Open (or reveal) the panel for a story. */
  static show(deps: StoryPanelDeps, projectKey: string, number: number): void {
    const key = `${projectKey}-${number}`
    const existing = StoryPanel.panels.get(key)
    if (existing) {
      existing.panel.reveal()
      void existing.load()
      return
    }
    StoryPanel.panels.set(key, new StoryPanel(deps, projectKey, number))
  }

  /** Re-load every open panel (after reconnecting, or switching user). */
  static refreshAll(): void {
    for (const p of StoryPanel.panels.values()) void p.load()
  }

  private constructor(
    private readonly deps: StoryPanelDeps,
    private readonly projectKey: string,
    private readonly number: number,
  ) {
    this.panel = vscode.window.createWebviewPanel('sdlcGovernance.story', `${projectKey}-${number}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist', 'webview')],
    })
    this.panel.iconPath = new vscode.ThemeIcon('notebook')
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables)
    this.panel.webview.onDidReceiveMessage(
      (msg: StoryToHost) =>
        void this.onMessage(msg).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          this.deps.log(`Story panel ${this.key}: ${msg.type} failed: ${message}`)
          void this.post({ type: 'notice', kind: 'error', message })
        }),
      undefined,
      this.disposables,
    )
    this.disposables.push(
      deps.onPlatformEvent((e) => {
        if (!('projectKey' in e) || e.projectKey !== this.projectKey) return
        const mine = (e.type === 'story.changed' || e.type === 'work.changed') && e.storyNumber === this.number
        const memory = e.type === 'memory.changed' && (e.storyNumber === this.number || e.storyNumber === null)
        if (mine || memory || e.type === 'project.changed') this.reloadSoon()
      }),
      deps.onTrackingChange(() => this.reloadSoon()),
    )
  }

  private get key(): string {
    return `${this.projectKey}-${this.number}`
  }

  private post(msg: HostToStory): Thenable<boolean> {
    return this.panel.webview.postMessage(msg)
  }

  private reloadSoon(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => void this.load(), 300)
  }

  private panelTracking(story: Story): PanelTracking {
    const t = this.deps.tracking()
    const ours = 'story' in t && t.story.projectKey === this.projectKey && t.story.number === this.number
    if (!ours) return { kind: 'other-branch' }
    switch (t.kind) {
      case 'tracking':
        return { kind: 'tracking', files: t.files }
      case 'not-yours':
        return { kind: 'not-yours' }
      case 'off':
        return { kind: 'off' }
      case 'offline':
        return { kind: 'offline', message: t.message }
      default:
        return story.actions.canReportWork ? { kind: 'other-branch' } : { kind: 'not-yours' }
    }
  }

  async load(): Promise<void> {
    if (this.loading) return this.loading
    this.loading = this.loadOnce().finally(() => {
      this.loading = undefined
    })
    return this.loading
  }

  private async loadOnce(): Promise<void> {
    const client = this.deps.client()
    if (!client) {
      void this.post({ type: 'notice', kind: 'error', message: 'Not connected to the SDLC platform.' })
      return
    }
    void this.post({ type: 'loading', loading: true })
    try {
      const story = await client.story(this.projectKey, this.number)
      this.story = story
      this.panel.title = `${story.key} · ${story.title}`
      const errors: string[] = []
      const soft = <T>(p: Promise<T>, what: string): Promise<T | null> =>
        p.catch((err: unknown) => {
          errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`)
          return null
        })
      const [work, memory, projectMemory, activity, project] = await Promise.all([
        soft(client.storyWork(this.projectKey, this.number), 'Code activity'),
        soft(client.storyMemory(this.projectKey, this.number), 'Story memory'),
        soft(client.projectMemory(this.projectKey, this.projectQuery ? { q: this.projectQuery } : { status: 'accepted' }), 'Project memory'),
        soft(client.storyActivity(this.projectKey, this.number), 'Activity'),
        story.actions.canAssign ? soft(client.project(this.projectKey), 'Members') : Promise.resolve(null),
      ])
      const members: AssignableMember[] | null = project
        ? project.members.filter((m) => m.role !== 'viewer').map((m) => ({ user: m.user, role: m.role }))
        : null
      const data: StoryPanelData = {
        story,
        work,
        memory: memory ?? [],
        projectMemory: (projectMemory ?? []).filter((m) => m.status === 'accepted'),
        projectQuery: this.projectQuery,
        me: this.deps.me() ?? null,
        tracking: this.panelTracking(story),
        branchName: storyBranchName(story),
        members,
        activity: activityLines(activity ?? []),
        activityHasMore: (activity?.length ?? 0) >= ACTIVITY_PAGE,
        error: errors.length ? errors.join(' · ') : undefined,
      }
      await this.post({ type: 'state', data })
    } catch (err) {
      await this.post({ type: 'notice', kind: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      void this.post({ type: 'loading', loading: false })
    }
  }

  private async onMessage(msg: StoryToHost): Promise<void> {
    const client = this.deps.client()
    switch (msg.type) {
      case 'ready':
      case 'refresh':
        await this.load()
        return
      case 'action':
        if (this.story) await this.deps.runStoryCommand(COMMANDS[msg.action], this.story)
        return
      case 'move':
        if (!client) return
        await client.move(this.projectKey, this.number, msg.to)
        await this.load()
        return
      case 'loadDiff': {
        if (!client) return
        try {
          const patch =
            msg.ref.kind === 'commit'
              ? await client.commitDiff(this.projectKey, this.number, msg.ref.sha)
              : await client.workspaceDiff(this.projectKey, this.number, msg.ref.userId)
          await this.post({ type: 'diff', key: diffKey(msg.ref), patch })
        } catch (err) {
          await this.post({ type: 'diff', key: diffKey(msg.ref), patch: null, error: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      case 'addMemory':
        if (!client) return
        await client.addStoryMemory(this.projectKey, this.number, { kind: msg.kind, title: msg.title, content: msg.content })
        await this.post({ type: 'notice', kind: 'info', message: 'Added to the story’s memory.' })
        await this.load()
        return
      case 'promoteMemory': {
        if (!client) return
        const promoted = await client.promoteMemory(this.projectKey, msg.id)
        await this.post({
          type: 'notice',
          kind: 'info',
          message: promoted.status === 'accepted' ? 'Added to project memory.' : 'Proposed for project memory — a lead will review it.',
        })
        await this.load()
        return
      }
      case 'archiveMemory':
        if (!client) return
        await client.archiveMemory(this.projectKey, msg.id)
        await this.load()
        return
      case 'searchProjectMemory': {
        if (!client) return
        this.projectQuery = msg.query.trim()
        const items = await client.projectMemory(this.projectKey, this.projectQuery ? { q: this.projectQuery } : { status: 'accepted' })
        await this.post({ type: 'projectMemory', query: this.projectQuery, items: items.filter((m) => m.status === 'accepted') })
        return
      }
      case 'openFile': {
        // Multi-root workspaces: the file can be in any folder — open the first that has it.
        const line = Math.max(0, (msg.line ?? 1) - 1)
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          const uri = vscode.Uri.joinPath(folder.uri, ...msg.path.split('/'))
          try {
            await vscode.workspace.fs.stat(uri)
          } catch {
            continue
          }
          const doc = await vscode.workspace.openTextDocument(uri)
          await vscode.window.showTextDocument(doc, { preview: true, selection: new vscode.Range(line, 0, line, 0) })
          return
        }
        void vscode.window.showWarningMessage(`${msg.path} is not in this workspace.`)
        return
      }
      case 'update': {
        if (!client || !this.story) return
        try {
          await client.updateStory(this.projectKey, this.number, { ...withCriterionIds(msg.edit), version: this.story.version })
          await this.post({ type: 'saved', field: msg.field, ok: true })
        } catch (err) {
          await this.post({ type: 'saved', field: msg.field, ok: false })
          if (err instanceof PlatformError && err.status === 409) {
            await this.post({ type: 'notice', kind: 'error', message: 'Someone else changed this story meanwhile — it has been reloaded. Make your change again.' })
          } else {
            throw err
          }
        } finally {
          await this.load()
        }
        return
      }
      case 'assign':
        if (!client) return
        await client.assignStory(this.projectKey, this.number, msg.userId)
        await this.load()
        return
      case 'loadOlderActivity': {
        if (!client) return
        const older = await client.storyActivity(this.projectKey, this.number, msg.before)
        await this.post({ type: 'olderActivity', lines: activityLines(older), hasMore: older.length >= ACTIVITY_PAGE })
        return
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview')
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'story.js'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'story.css'))
    const n = nonce()
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${n}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
    ].join('; ')
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>${this.key}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`
  }

  private dispose(): void {
    StoryPanel.panels.delete(this.key)
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}
