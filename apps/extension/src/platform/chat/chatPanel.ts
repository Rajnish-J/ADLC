// The Chat panel: the platform's specialist assistants inside VS Code — the same conversations, drafts and
// approvals as the web app's /chat. The webview renders; this host makes the API calls with the platform
// connection's identity and streams the assistant's answers back to it.

import * as vscode from 'vscode'
import { ApiErrorSchema, type DraftRef, type PlatformEvent } from '@sdlc/contracts'
import type { PlatformClient } from '../platformClient'
import { isAllowed, type ChatToHost, type HostToChat } from './chatPanelMessages'

export interface ChatPanelDeps {
  extensionUri: vscode.Uri
  client: () => PlatformClient | undefined
  /** Display name of the signed-in user, if any. */
  userName: () => string | undefined
  webUrl: () => string
  onPlatformEvent: vscode.Event<PlatformEvent>
  /** Fires when the platform connection changes (sign in / out, settings). */
  onConnectionChanged: vscode.Event<void>
  log: (message: string) => void
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
  return out
}

/** The web page for what a submitted draft created (stories open in a Story panel instead). */
function webPath(ref: DraftRef): string {
  const base = `/projects/${ref.projectKey}`
  switch (ref.type) {
    case 'workflow':
      return `${base}/workflow`
    case 'project':
      return base
    case 'agent':
      return `${base}/${ref.kind === 'skill' ? 'skills' : 'agents'}/${encodeURIComponent(ref.slug)}`
    case 'stories':
      return base
  }
}

export class ChatPanel {
  private static current: ChatPanel | undefined

  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []
  private readonly streams = new Map<string, AbortController>()

  static show(deps: ChatPanelDeps): void {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal()
      return
    }
    ChatPanel.current = new ChatPanel(deps)
  }

  private constructor(private readonly deps: ChatPanelDeps) {
    this.panel = vscode.window.createWebviewPanel('sdlcGovernance.chat', 'SDLC Chat', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist', 'webview')],
    })
    this.panel.iconPath = new vscode.ThemeIcon('comment-discussion')
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables)
    this.panel.webview.onDidReceiveMessage(
      (msg: ChatToHost) =>
        void this.onMessage(msg).catch((err: unknown) => this.deps.log(`Chat panel: ${msg.type} failed: ${err instanceof Error ? err.message : String(err)}`)),
      undefined,
      this.disposables,
    )
    this.disposables.push(
      deps.onConnectionChanged(() => void this.init()),
      deps.onPlatformEvent((event) => {
        // Pages refresh on these; the panel uses them to refresh drafts and the project list.
        if (event.type === 'project.changed') void this.post({ type: 'platformEvent', event })
      }),
    )
  }

  private post(msg: HostToChat): Thenable<boolean> {
    return this.panel.webview.postMessage(msg)
  }

  private init(): Thenable<boolean> {
    return this.post({ type: 'init', signedIn: Boolean(this.deps.client()), userName: this.deps.userName() ?? null, webUrl: this.deps.webUrl() })
  }

  private async onMessage(msg: ChatToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.init()
        return
      case 'signIn':
        await vscode.commands.executeCommand('sdlcGovernance.platform.connect')
        return
      case 'request':
        await this.request(msg.requestId, msg.method, msg.path, msg.body)
        return
      case 'send':
        await this.stream(msg.requestId, msg.body)
        return
      case 'abort':
        this.streams.get(msg.requestId)?.abort()
        this.streams.delete(msg.requestId)
        return
      case 'openRef':
        if (msg.ref.type === 'stories' && msg.ref.numbers.length === 1) {
          await vscode.commands.executeCommand('sdlcGovernance.platform.openStory', { projectKey: msg.ref.projectKey, number: msg.ref.numbers[0] })
        } else {
          await vscode.env.openExternal(vscode.Uri.parse(`${this.deps.webUrl()}${webPath(msg.ref)}`))
        }
        return
    }
  }

  private async request(requestId: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown): Promise<void> {
    const client = this.deps.client()
    const reply = (ok: boolean, status: number, data: unknown, message: string | null) => this.post({ type: 'response', requestId, ok, status, data, message })
    if (!client) return void reply(false, 401, null, 'Sign in to the SDLC platform first.')
    if (!isAllowed(method, path)) return void reply(false, 403, null, `Not available from the chat panel: ${method} ${path}`)
    try {
      const res = await fetch(`${client.apiUrl}/api/v1${path}`, {
        method,
        headers: client.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      const message = res.ok ? null : (ApiErrorSchema.safeParse(json).data?.message ?? `Request failed (${res.status}).`)
      await reply(res.ok, res.status, json, message)
    } catch (err) {
      await reply(false, 0, null, `Cannot reach the SDLC platform API${err instanceof Error ? ` (${err.message})` : ''}.`)
    }
  }

  /** POST /chat and forward the event stream to the webview as it arrives. */
  private async stream(requestId: string, body: unknown): Promise<void> {
    const client = this.deps.client()
    if (!client) {
      await this.post({ type: 'streamError', requestId, status: 401, message: 'Sign in to the SDLC platform first.' })
      return
    }
    const abort = new AbortController()
    this.streams.set(requestId, abort)
    try {
      const res = await fetch(`${client.apiUrl}/api/v1/chat`, {
        method: 'POST',
        headers: client.headers({ 'content-type': 'application/json', accept: 'text/event-stream' }),
        body: JSON.stringify(body),
        signal: abort.signal,
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        let message = `The assistant could not answer (${res.status}).`
        try {
          message = ApiErrorSchema.parse(JSON.parse(text)).message
        } catch {
          // Not an API error body.
        }
        await this.post({ type: 'streamError', requestId, status: res.status, message })
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await this.post({ type: 'chunk', requestId, text: decoder.decode(value, { stream: true }) })
      }
      await this.post({ type: 'end', requestId })
    } catch (err) {
      if (abort.signal.aborted) await this.post({ type: 'end', requestId })
      else await this.post({ type: 'streamError', requestId, status: 0, message: `Cannot reach the SDLC platform API${err instanceof Error ? ` (${err.message})` : ''}.` })
    } finally {
      this.streams.delete(requestId)
    }
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview')
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'chat.js'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'chat.css'))
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
  <title>SDLC Chat</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`
  }

  private dispose(): void {
    ChatPanel.current = undefined
    for (const a of this.streams.values()) a.abort()
    this.streams.clear()
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}

/** The "SDLC: Open Chat" command. */
export function registerChatPanel(deps: ChatPanelDeps): vscode.Disposable {
  return vscode.commands.registerCommand('sdlcGovernance.platform.openChat', () => ChatPanel.show(deps))
}
