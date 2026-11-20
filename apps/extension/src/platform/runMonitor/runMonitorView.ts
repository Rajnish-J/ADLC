// The Run monitor view (SDLC sidebar; drag it to the Secondary Side Bar to keep it on the right): your workflow
// runs, live — the orchestrator, each agent step and what it is doing, subagents, the approval a run waits on, and
// where it is in the workflow. The same agent map as the web's run monitor, fed by the platform's live events and
// its run APIs. It follows a run by itself when one of yours starts.

import { randomBytes } from 'crypto'
import * as vscode from 'vscode'
import { buildRunMap, type RunMapSpecNode } from '@sdlc/core'
import type { ActiveRun, PlatformEvent, ProjectRunDetail, RunEvent } from '@sdlc/contracts'
import type { PlatformHandle } from '../platformHandle'
import { RUN_MONITOR_CSS, renderRunMonitor, type RunOption } from './runMonitorHtml'

export const RUN_MONITOR_VIEW = 'sdlcGovernance.runMonitor'
const TIP_KEY = 'sdlcGovernance.runMonitor.tipShown'
const LIVE = new Set(['requested', 'queued', 'running', 'awaiting_approval'])

interface Followed {
  projectKey: string
  runId: string
}

type Message =
  | { type: 'pick'; runId: string; projectKey: string }
  | { type: 'approve' | 'reject'; stepId: string }
  | { type: 'open' }
  | { type: 'stop' }
  | { type: 'ready' }

function optionOf(r: { runId: string; projectKey: string; storyNumber: number | null; prompt: string | null; workflowName: string; status: string }): RunOption {
  const p = r.prompt?.trim()
  const label = r.storyNumber != null ? `${r.projectKey}-${r.storyNumber}` : p ? `Quick fix: ${p.length > 36 ? `${p.slice(0, 36)}…` : p}` : r.workflowName
  return { runId: r.runId, projectKey: r.projectKey, label, status: r.status }
}

export class RunMonitorView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private runs: ActiveRun[] = []
  private followed?: Followed
  private detail?: ProjectRunDetail
  private events: RunEvent[] = []
  private lastSeq = -1
  private spec: { workflowId: string; nodes: RunMapSpecNode[] } | null = null
  private error: string | null = null
  private refreshTimer?: ReturnType<typeof setTimeout>
  private readonly ticker: ReturnType<typeof setInterval>
  private readonly subscriptions: vscode.Disposable[] = []

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly platform: PlatformHandle,
  ) {
    this.subscriptions.push(
      platform.onEvent((e) => this.onEvent(e)),
      platform.onDidChangeConnection(() => this.schedule(0)),
      vscode.commands.registerCommand('sdlcGovernance.runMonitor.focus', () => this.reveal(false)),
    )
    // Elapsed times tick while a followed run is live and the view is visible.
    this.ticker = setInterval(() => {
      if (this.view?.visible && this.detail && LIVE.has(this.detail.status)) this.render()
    }, 1000)
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = this.shell()
    view.webview.onDidReceiveMessage((m: Message) => void this.onMessage(m))
    view.onDidChangeVisibility(() => view.visible && this.schedule(0))
    this.schedule(0)
  }

  /** Follow a run (and show the view without taking focus from the harness). */
  follow(projectKey: string, runId: string): void {
    if (this.followed?.runId !== runId) {
      this.followed = { projectKey, runId }
      this.detail = undefined
      this.events = []
      this.lastSeq = -1
    }
    this.reveal(true)
    this.schedule(0)
  }

  private reveal(preserveFocus: boolean): void {
    if (this.view) this.view.show(preserveFocus)
    else void vscode.commands.executeCommand(`${RUN_MONITOR_VIEW}.focus`)
    if (!this.context.globalState.get<boolean>(TIP_KEY)) {
      void this.context.globalState.update(TIP_KEY, true)
      void vscode.window.showInformationMessage('Tip: drag the Run monitor view to the Secondary Side Bar to keep it on the right while agents work.')
    }
  }

  private onEvent(e: PlatformEvent): void {
    const me = this.platform.me()?.user.id
    if ((e.type === 'run.requested' || e.type === 'run.step') && e.targetUserId === me) {
      if (e.type === 'run.requested' || this.followed?.runId !== e.runId) this.follow(e.projectKey, e.runId)
      return
    }
    if (e.type === 'run.activity' && e.runId === this.followed?.runId) this.schedule(250)
    else if (e.type === 'work.changed' && e.kind === 'run') this.schedule(400)
    else if (e.type === 'ready') this.schedule(0)
  }

  private schedule(ms: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => void this.refresh(), ms)
  }

  private async refresh(): Promise<void> {
    const client = this.platform.client()
    if (!client || !this.view?.visible) {
      this.render()
      return
    }
    try {
      this.runs = await client.activeRuns()
      if (!this.followed && this.runs[0]) this.followed = { projectKey: this.runs[0].projectKey, runId: this.runs[0].runId }
      const f = this.followed
      if (f) {
        const [detail, page] = await Promise.all([client.projectRun(f.projectKey, f.runId), client.runEvents(f.projectKey, f.runId, this.lastSeq)])
        if (this.followed?.runId !== f.runId) return // switched meanwhile
        this.detail = detail
        const seen = new Set(this.events.map((e) => e.seq))
        this.events = [...this.events, ...page.events.filter((e) => !seen.has(e.seq))].slice(-2000)
        this.lastSeq = Math.max(this.lastSeq, page.lastSeq)
        if (detail.workflowId && this.spec?.workflowId !== detail.workflowId) {
          const wf = await client.workflow(f.projectKey, detail.workflowId).catch(() => undefined)
          this.spec = wf ? { workflowId: detail.workflowId, nodes: wf.spec.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label })) } : null
        }
      }
      this.error = null
    } catch (err) {
      this.error = `Could not load your runs: ${err instanceof Error ? err.message : String(err)}`
    }
    this.render()
  }

  private render(): void {
    if (!this.view) return
    const d = this.detail
    const options = this.runs.map(optionOf)
    let followed = this.followed ? (options.find((o) => o.runId === this.followed?.runId) ?? null) : null
    if (!followed && this.followed && d) {
      followed = optionOf({ ...d, runId: d.id, projectKey: this.followed.projectKey, storyNumber: d.story?.number ?? null })
      options.unshift(followed)
    }
    const map = d
      ? buildRunMap(
          d,
          d.steps.map((s) => ({ ...s, nodeId: s.nodeId ?? null })),
          this.events,
          this.spec?.nodes ?? null,
        )
      : null
    const html = renderRunMonitor({
      connected: !!this.platform.client(),
      runs: options,
      followed,
      map,
      pending: d && d.status === 'awaiting_approval' ? d.pendingApproval : null,
      error: this.error,
    })
    void this.view.webview.postMessage({ type: 'render', html })
  }

  private async onMessage(m: Message): Promise<void> {
    const client = this.platform.client()
    const f = this.followed
    if (m.type === 'ready') return this.render()
    if (m.type === 'pick') return this.follow(m.projectKey, m.runId)
    if (!client || !f) return
    try {
      if (m.type === 'approve') {
        await client.approveRun(f.projectKey, f.runId, { approve: true, stepId: m.stepId })
      } else if (m.type === 'reject') {
        const comment = await vscode.window.showInputBox({ title: 'Reject', prompt: 'Why? (optional — recorded on the run)', ignoreFocusOut: true })
        if (comment === undefined) return
        await client.approveRun(f.projectKey, f.runId, { approve: false, stepId: m.stepId, ...(comment.trim() ? { comment: comment.trim() } : {}) })
      } else if (m.type === 'stop') {
        const ok = await vscode.window.showWarningMessage('Stop this run?', { modal: true }, 'Stop')
        if (ok !== 'Stop') return
        await client.cancelRun(f.projectKey, f.runId, 'Stopped from the VS Code run monitor.')
      } else if (m.type === 'open') {
        this.platform.openInBrowser(`/projects/${encodeURIComponent(f.projectKey)}/workflow/runs/${encodeURIComponent(f.runId)}`)
        return
      }
      this.schedule(0)
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  private shell(): string {
    const nonce = randomBytes(16).toString('base64')
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">${RUN_MONITOR_CSS}</style></head>
<body><div id="root"><p class="empty">Loading…</p></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const open = new Set((vscode.getState() || {}).open || []);
const root = document.getElementById('root');
function apply() {
  for (const el of root.querySelectorAll('[data-details]')) el.classList.toggle('open', open.has(el.dataset.details));
}
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'render') { root.innerHTML = e.data.html; apply(); }
});
root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT') return;
  const action = el.dataset.action;
  if (action === 'toggle') {
    const id = el.dataset.step;
    if (open.has(id)) open.delete(id); else open.add(id);
    vscode.setState({ open: [...open] });
    apply();
  } else {
    vscode.postMessage({ type: action, stepId: el.dataset.step });
  }
});
root.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.action === 'pick') {
    const opt = el.options[el.selectedIndex];
    vscode.postMessage({ type: 'pick', runId: el.value, projectKey: opt.dataset.project });
  }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`
  }

  dispose(): void {
    clearInterval(this.ticker)
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    for (const s of this.subscriptions) s.dispose()
  }
}
