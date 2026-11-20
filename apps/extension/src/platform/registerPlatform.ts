// Connects the extension to the SDLC platform backend: the Platform Stories view, its commands (connect, pick up,
// move, open in browser, copy branch, start a workflow run on a story) and live refresh over SSE. Inert until
// `sdlcGovernance.platform.apiUrl` is set — local-only use of the extension is unchanged.

import * as vscode from 'vscode'
import type { AgentDetail, Me, PlatformEvent, Story } from '@sdlc/contracts'
import { HARNESS_TIER_LABELS } from '@sdlc/contracts'
import type { AgentFileWrite } from '../runtime/dispatch/lmAgentDispatcher'
import type { RunService } from '../runtime/runService'
import type { WorkflowSpec } from '../runtime/spec'
import { WorkflowStore } from '../runtime/workflowStore'
import { WorkflowCanvasPanel } from '../webview/workflowCanvasPanel'
import { registerChatPanel } from './chat/chatPanel'
import { registerPlatformAgents } from './platformAgentRegistry'
import type { CatalogNode } from './platformCatalogProviders'
import { startPresence } from './presence'
import { installed } from './engines/registry'
import { PlatformClient, PlatformError } from './platformClient'
import type { PlatformHandle } from './platformHandle'
import { subscribePlatformEvents } from './platformEvents'
import { PlatformStoriesProvider, type PlatformNode } from './platformStoriesProvider'
import { storyBranchName, storyTaskPrompt } from './storyFormat'
import { registerStoryWork } from './storyWork'

const VIEW_ID = 'sdlcGovernance.platformStories'
const CONNECTED_KEY = 'sdlcGovernance.platformConnected'
const DEFAULT_API_URL = 'http://127.0.0.1:4000'
/** The personal access token lives in VS Code's secret storage, never in settings. */
const TOKEN_SECRET = 'sdlcGovernance.platform.accessToken'

interface PlatformSettings {
  apiUrl: string
  webUrl: string
  devUser: string
}

function readSettings(): PlatformSettings {
  const cfg = vscode.workspace.getConfiguration('sdlcGovernance.platform')
  return {
    apiUrl: cfg.get<string>('apiUrl', '').trim(),
    webUrl: cfg.get<string>('webUrl', 'http://localhost:3000').trim().replace(/\/+$/, ''),
    devUser: cfg.get<string>('devUser', '').trim(),
  }
}

function storyOf(node: PlatformNode | undefined): Story | undefined {
  return node?.kind === 'story' ? node.story : undefined
}

export interface PlatformDeps {
  runs: RunService
  extensionUri: vscode.Uri
  /** The LM dispatcher's per-step file writes, so story runs record which files each agent changed. */
  onDidWriteFile?: vscode.Event<AgentFileWrite>
}

export function registerPlatform(context: vscode.ExtensionContext, deps: PlatformDeps): PlatformHandle {
  const provider = new PlatformStoriesProvider()
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true })
  const output = vscode.window.createOutputChannel('SDLC Platform')
  const platformEvents = new vscode.EventEmitter<PlatformEvent>()
  const connectionChanged = new vscode.EventEmitter<void>()
  let client: PlatformClient | undefined
  let events: { dispose(): void } | undefined
  let me: Me | undefined
  let loadingMe: Promise<Me | undefined> | undefined
  /** Cached copy of the secret (read at start and whenever it changes), so connect() stays synchronous. */
  let accessToken: string | undefined

  // Code activity, agent-run reporting, the Story panel and memory commands — all follow `client`.
  const work = registerStoryWork({
    context,
    runs: deps.runs,
    onDidWriteFile: deps.onDidWriteFile,
    client: () => client,
    me: () => provider.currentUser?.user,
    onPlatformEvent: platformEvents.event,
    log: (message) => output.appendLine(`[${new Date().toISOString()}] ${message}`),
  })

  // Settings → VS Code: this window's heartbeat, which also brings in the user's preferred agent engine.
  const presence = startPresence(context, () => client, (message) => output.appendLine(`[${new Date().toISOString()}] ${message}`))

  // Platform Chat: the specialist assistants in a VS Code panel (SDLC: Open Chat).
  context.subscriptions.push(
    registerChatPanel({
      extensionUri: deps.extensionUri,
      client: () => client,
      userName: () => provider.currentUser?.user.displayName,
      webUrl: () => readSettings().webUrl,
      onPlatformEvent: platformEvents.event,
      onConnectionChanged: connectionChanged.event,
      log: (message) => output.appendLine(`[${new Date().toISOString()}] ${message}`),
    }),
  )

  const connect = (): void => {
    events?.dispose()
    events = undefined
    const settings = readSettings()
    client = settings.apiUrl ? new PlatformClient({ apiUrl: settings.apiUrl, token: accessToken, devUser: settings.devUser || undefined }) : undefined
    me = undefined
    loadingMe = undefined
    void vscode.commands.executeCommand('setContext', CONNECTED_KEY, Boolean(client))
    provider.setClient(client)
    connectionChanged.fire()
    view.message = undefined
    work.refresh()
    presence.reset()
    if (!client) return

    // Coalesce bursts of changes (a pick-up is several events) into one refresh.
    let pending: ReturnType<typeof setTimeout> | undefined
    events = subscribePlatformEvents(client, {
      onEvent: (event) => {
        platformEvents.fire(event)
        if (event.type === 'preferences.changed') presence.beat()
        // Live working-state snapshots don't change the tree (memory does: each project shows its memory), and
        // neither do agent steps waiting for a harness (re-sent every ~30 s; HarnessSessions handles them).
        if (event.type === 'work.changed' || event.type === 'run.step') return
        if (pending) clearTimeout(pending)
        pending = setTimeout(() => provider.refresh(), 200)
      },
      onStatus: (live) => {
        view.description = live ? 'live' : 'reconnecting…'
      },
    })
  }

  const withClient = async <T>(action: (c: PlatformClient) => Promise<T>): Promise<T | undefined> => {
    if (!client) {
      void vscode.window.showWarningMessage('Connect to the SDLC platform first.')
      return undefined
    }
    try {
      return await action(client)
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }

  const openInBrowser = (path: string): void => {
    void vscode.env.openExternal(vscode.Uri.parse(`${readSettings().webUrl}${path}`))
  }

  context.subscriptions.push(
    view,
    output,
    platformEvents,
    connectionChanged,
    { dispose: () => events?.dispose() },
    presence,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sdlcGovernance.platform')) connect()
    }),
    context.secrets.onDidChange(async (e) => {
      if (e.key !== TOKEN_SECRET) return
      accessToken = (await context.secrets.get(TOKEN_SECRET)) || undefined
      connect()
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.connect', async () => {
      const current = readSettings()
      const apiUrl = (
        await vscode.window.showInputBox({
          title: 'Connect to the SDLC platform',
          prompt: 'Backend API URL',
          value: current.apiUrl || DEFAULT_API_URL,
          ignoreFocusOut: true,
        })
      )?.trim()
      if (!apiUrl) return
      const cfg = vscode.workspace.getConfiguration('sdlcGovernance.platform')

      // An API with the dev sign-in lists its seeded users; one with Microsoft sign-in answers 404 and needs a token.
      let users: Awaited<ReturnType<PlatformClient['devUsers']>> | undefined
      try {
        users = await new PlatformClient({ apiUrl }).devUsers()
      } catch (err) {
        if (!(err instanceof PlatformError && err.status === 404)) {
          void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
          return
        }
      }

      if (users) {
        const TOKEN_ITEM = { label: '$(key) Use an access token…', description: 'created on the web under Settings → VS Code', email: '' }
        const picked = await vscode.window.showQuickPick(
          [...users.map((u) => ({ label: u.displayName, description: u.email, detail: u.orgRole === 'org_admin' ? 'Org admin' : undefined, email: u.email })), TOKEN_ITEM],
          { title: 'Sign in as (local development)', placeHolder: 'Choose a user', ignoreFocusOut: true },
        )
        if (!picked) return
        if (picked !== TOKEN_ITEM) {
          await context.secrets.delete(TOKEN_SECRET)
          await cfg.update('apiUrl', apiUrl, vscode.ConfigurationTarget.Global)
          await cfg.update('devUser', picked.email, vscode.ConfigurationTarget.Global)
          void vscode.window.showInformationMessage(`Connected to the SDLC platform as ${picked.label}.`)
          return
        }
      }

      const settingsUrl = `${current.webUrl}/settings/vscode`
      const token = (
        await vscode.window.showInputBox({
          title: 'Connect to the SDLC platform',
          prompt: `Paste a personal access token from the web app (Settings → VS Code). Press Enter with it empty to open that page.`,
          placeHolder: 'sdlc_pat_…',
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() && !v.trim().startsWith('sdlc_pat_') ? 'Access tokens start with sdlc_pat_' : undefined),
        })
      )?.trim()
      if (!token) {
        if (token === '') void vscode.env.openExternal(vscode.Uri.parse(settingsUrl))
        return
      }
      let who: Me
      try {
        who = await new PlatformClient({ apiUrl, token }).me()
      } catch (err) {
        const open = await vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err), 'Open web settings')
        if (open) void vscode.env.openExternal(vscode.Uri.parse(settingsUrl))
        return
      }
      accessToken = token
      await context.secrets.store(TOKEN_SECRET, token)
      await cfg.update('devUser', undefined, vscode.ConfigurationTarget.Global)
      await cfg.update('apiUrl', apiUrl, vscode.ConfigurationTarget.Global)
      // The secret and setting changes above reconnect (onDidChange / onDidChangeConfiguration).
      void vscode.window.showInformationMessage(`Connected to the SDLC platform as ${who.user.displayName}.`)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.disconnect', async () => {
      accessToken = undefined
      await context.secrets.delete(TOKEN_SECRET)
      const cfg = vscode.workspace.getConfiguration('sdlcGovernance.platform')
      await cfg.update('apiUrl', undefined, vscode.ConfigurationTarget.Global)
      await cfg.update('devUser', undefined, vscode.ConfigurationTarget.Global)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('sdlcGovernance.platform.pickUp', async (node?: PlatformNode) => {
      const story = storyOf(node)
      if (!story) return
      const updated = await withClient((c) => c.pickUp(story.projectKey, story.number))
      if (!updated) return
      provider.refresh()
      const branch = storyBranchName(updated)
      const choice = await vscode.window.showInformationMessage(
        `You picked up ${updated.key}. Work on branch ${branch} — your commits and changes on it are shared with the team.`,
        'Create Branch',
        'Start Workflow',
        'Copy Branch Name',
      )
      const target = { kind: 'story', story: updated }
      if (choice === 'Create Branch') await vscode.commands.executeCommand('sdlcGovernance.platform.createBranch', target)
      if (choice === 'Copy Branch Name') await vscode.env.clipboard.writeText(branch)
      if (choice === 'Start Workflow') await vscode.commands.executeCommand('sdlcGovernance.platform.startWorkflow', target)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.moveStory', async (node?: PlatformNode) => {
      const story = storyOf(node)
      if (!story || story.actions.transitions.length === 0) return
      const picked = await vscode.window.showQuickPick(
        story.actions.transitions.map((t) => ({ label: t.label, to: t.to })),
        { title: `Move ${story.key}` },
      )
      if (!picked) return
      if (await withClient((c) => c.move(story.projectKey, story.number, picked.to))) provider.refresh()
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.openInBrowser', (node?: PlatformNode | CatalogNode) => {
      if (node?.kind === 'story') openInBrowser(`/projects/${node.story.projectKey}/stories/${node.story.number}`)
      else if (node?.kind === 'project') openInBrowser(`/projects/${node.project.key}`)
      else if (node?.kind === 'workflow' || node?.kind === 'step' || node?.kind === 'run') openInBrowser(`/projects/${node.project.key}/workflow`)
      else if (node?.kind === 'agent') openInBrowser(`/projects/${node.project.key}/agents/${encodeURIComponent(node.agent.slug)}`)
      else if (node?.kind === 'memory' || node?.kind === 'memoryItem' || node?.kind === 'memoryProposed') openInBrowser(`/projects/${node.project.key}/memory`)
      else openInBrowser('/')
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.copyBranchName', async (node?: PlatformNode) => {
      const story = storyOf(node)
      if (!story) return
      await vscode.env.clipboard.writeText(storyBranchName(story))
      void vscode.window.setStatusBarMessage(`Copied ${storyBranchName(story)}`, 3000)
    }),

    // Run a workflow in this window seeded with the story — its description and acceptance criteria become every
    // agent's work item. The project's workflows (from the platform, agents bound by slug) come first, then this
    // workspace's local ones.
    vscode.commands.registerCommand('sdlcGovernance.platform.startWorkflow', async (node?: PlatformNode) => {
      const story = storyOf(node)
      if (!story) return
      if (!vscode.workspace.workspaceFolders?.length) {
        void vscode.window.showWarningMessage('Open the story’s repository folder first — agents work on the files in your workspace.')
        return
      }
      const store = WorkflowStore.forActiveWorkspace(context.globalState)
      const local = store ? await store.listAll() : []
      let projectWorkflows: Array<{ id: string; name: string; isDefault: boolean; version: number }> = []
      try {
        projectWorkflows = (await client?.workflows(story.projectKey)) ?? []
      } catch (err) {
        output.appendLine(`[${new Date().toISOString()}] Could not list ${story.projectKey} workflows: ${err instanceof Error ? err.message : String(err)}`)
      }
      type Pick = vscode.QuickPickItem & { source?: 'project' | 'local'; id?: string }
      const items: Pick[] = [
        ...(projectWorkflows.length ? [{ label: `${story.projectKey} project`, kind: vscode.QuickPickItemKind.Separator } as Pick] : []),
        ...projectWorkflows.map((w): Pick => ({ label: w.name, description: `${w.isDefault ? 'default · ' : ''}v${w.version}`, source: 'project', id: w.id })),
        ...(local.length ? [{ label: 'This workspace', kind: vscode.QuickPickItemKind.Separator } as Pick] : []),
        ...local.map((e): Pick => ({ label: e.name, description: e.isDefault ? 'default' : undefined, source: 'local', id: e.id })),
      ]
      const choices = items.filter((i) => i.source)
      if (choices.length === 0) {
        void vscode.window.showWarningMessage('No workflows found for this project or workspace.')
        return
      }
      const picked = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(items, { title: `Run a workflow on ${story.key}` })
      const pickedId = picked?.id
      if (!pickedId) return

      // A project workflow can run in a harness installed here (Copilot, Claude Code, Codex…) — the same as starting
      // it from the web — or in the built-in runtime.
      if (picked.source === 'project') {
        const harnesses = installed()
        if (harnesses.length) {
          type Where = vscode.QuickPickItem & { engine?: string }
          const where = await vscode.window.showQuickPick<Where>(
            [
              ...harnesses.map((h): Where => ({ label: `$(hubot) ${h.label}`, description: `${h.version ?? ''} · ${HARNESS_TIER_LABELS[h.tier]}`, engine: h.id })),
              { label: '$(gear) Built-in runtime', description: 'Agents run on VS Code language models in this window' },
            ],
            { title: `Run ${picked.label} on ${story.key} in…` },
          )
          if (!where) return
          if (where.engine) {
            await vscode.commands.executeCommand('sdlcGovernance.platform.startInHarness', story, pickedId, where.engine, null)
            return
          }
        }
      }

      let spec: WorkflowSpec | undefined
      if (picked.source === 'project') {
        spec = await withClient(async (c) => {
          const detail = await c.workflow(story.projectKey, pickedId)
          const agentSteps = detail.spec.nodes.filter((n) => n.kind === 'agent')
          const unassigned = agentSteps.filter((n) => !n.data.agentId).map((n) => n.label)
          if (unassigned.length) {
            const go = await vscode.window.showWarningMessage(
              `${unassigned.join(', ')} ${unassigned.length === 1 ? 'has' : 'have'} no agent mapped in ${detail.name}. Run anyway?`,
              { modal: true },
              'Run Anyway',
            )
            if (go !== 'Run Anyway') return undefined
          }
          // The agents' instructions live on the platform: fetch and register them for the dispatcher.
          const slugs = [...new Set(agentSteps.flatMap((n) => (n.data.agentId ? [n.data.agentId] : [])))]
          const agents: AgentDetail[] = await Promise.all(slugs.map((slug) => c.agent(story.projectKey, slug)))
          registerPlatformAgents(agents)
          return detail.spec
        })
      } else {
        spec = await store?.loadById(pickedId)
      }
      if (!spec) return
      // `||`, not `??`: an unset devUser setting is '' — never let the run's actor be an empty string.
      const actor = provider.currentUser?.user.email || readSettings().devUser || 'local-user'
      // Give every agent the story's memory and the project's knowledge alongside the story itself.
      let task = storyTaskPrompt(story)
      try {
        const memory = await client?.memoryContext(story.projectKey, story.number)
        if (memory?.markdown) task += `\n\n## Project knowledge\n\n${memory.markdown}`
      } catch (err) {
        output.appendLine(`[${new Date().toISOString()}] No memory context for ${story.key}: ${err instanceof Error ? err.message : String(err)}`)
      }
      // The run is reported to the platform against storyKey (see work/runReporter).
      const state = await deps.runs.startRun(spec, actor, { task, storyKey: story.key })
      WorkflowCanvasPanel.render({ extensionUri: deps.extensionUri, runService: deps.runs }, spec, state)
    }),
  )

  void context.secrets.get(TOKEN_SECRET).then(
    (t) => {
      accessToken = t || undefined
      connect()
    },
    () => connect(),
  )

  return {
    client: () => client,
    me: () => provider.currentUser ?? me,
    ensureMe: () => {
      const existing = provider.currentUser ?? me
      if (existing || !client) return Promise.resolve(existing)
      const c = client
      loadingMe ??= c
        .me()
        .then((loaded) => {
          if (client === c) me = loaded
          return loaded
        })
        .catch(() => undefined)
        .finally(() => {
          loadingMe = undefined
        })
      return loadingMe
    },
    onDidChangeConnection: connectionChanged.event,
    onEvent: platformEvents.event,
    openInBrowser,
  }
}
