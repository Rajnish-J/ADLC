// Phase 5A/5B — the canvas/builder WebviewPanel manager (host side).
//
// Owns a single reusable panel that operates in three modes:
//   • View mode  (render)        — read-only, streams live RunState overlays
//   • Builder mode (renderBuilder) — full authoring: drag, connect, add nodes, save
//   • Project mode (renderPlatform) — a project workflow from the SDLC platform with its step → agent mapping,
//     the same view (and the same mapping rules) as the web app's Workflow page
//
// ▶ Start runs in the user's selected harness through the platform (session/harnessStart.ts); signed out, or by
// choice, a workflow runs on the built-in runtime.
//
// Strict CSP (per-load nonce, no inline scripts), webview resource URIs for the bundled React app,
// and a typed postMessage bridge (see messages.ts).

import * as vscode from 'vscode'
import { ARM_SCOPE } from '../foundry/constants'
import { getAccountLabel } from '../auth/azureAuth'
import type { RunService } from '../runtime/runService'
import type { RunState } from '../runtime/port'
import type { WorkflowSpec } from '../runtime/spec'
import { PROJECT_ROLE_LABELS, type ProjectSummary } from '@sdlc/contracts'
import type { HostToWebview, WebviewToHost, AgentSummary, AiAssistant, PlatformWorkflowLink, PlatformWorkflowView } from './messages'
import { isDefaultWorkflowId, type WorkflowStore } from '../runtime/workflowStore'
import { builtinAgentFile, listBuiltinAgents } from '../runtime/builtinAgentRegistry'
import { platformHandle } from '../platform/platformAccess'
import { canIn } from '../platform/platformHandle'
import { showReadonlyMarkdown } from '../platform/readonlyDocs'
import { registerPlatformAgents } from '../platform/platformAgentRegistry'
import { startLocalWorkflow, startProjectWorkflow, workspaceProject } from '../platform/session/harnessStart'
import { harnessOptions } from '../platform/engines/registry'
import type { DiscoveredAgentsProvider } from '../views/discoveredAgentsProvider'
import type { WorkflowsProvider } from '../views/workflowsProvider'
import { blankSpec } from '../runtime/specUtils'
import { seedRunInputs } from '../chat/seedRunInputs'

/** Sentinel workflow id used to open the builder in create-from-agents mode (not yet persisted). */
export const NEW_WORKFLOW_ID = '__new__'

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export interface PanelDeps {
  extensionUri: vscode.Uri
  runService: RunService
  store?: WorkflowStore
  discovered?: DiscoveredAgentsProvider
  workflowsView?: WorkflowsProvider
  /** Fetch Azure Foundry-registered agents (degrades to [] on failure). */
  fetchFoundryAgents?: () => Promise<AgentSummary[]>
}

/** A project workflow open in the canvas. */
interface PlatformTarget {
  projectKey: string
  workflowId: string
}

export class WorkflowCanvasPanel {
  private static current: WorkflowCanvasPanel | undefined
  /** Deps for panels opened without any (project workflows from the Workflows view); set on activation. */
  private static defaults: PanelDeps | undefined
  /** Surfaces message-handler failures that would otherwise vanish as unhandled rejections. */
  private static readonly output = vscode.window.createOutputChannel('SDLC Governance')

  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []
  private spec: WorkflowSpec
  private workflowId: string | undefined
  private isBuilder = false
  private isReadOnly = false
  private createMode = false
  private platform: PlatformTarget | undefined
  private platformView: PlatformWorkflowView | undefined
  private platformLink: PlatformWorkflowLink | undefined
  private runId: string | undefined
  private readonly deps: PanelDeps
  /** Cached Foundry agent list (fetched lazily; refreshed on requestAgents). */
  private foundryCache: AgentSummary[] | undefined

  private constructor(deps: PanelDeps, spec: WorkflowSpec, runState: RunState | undefined) {
    this.deps = deps
    this.spec = spec
    this.runId = runState?.runId
    this.panel = vscode.window.createWebviewPanel(
      'sdlcGovernance.canvas',
      'Workflow Canvas',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist', 'webview')],
      },
    )

    this.panel.webview.html = this.html(this.panel.webview)

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) =>
        void this.onMessage(msg, runState).catch((err) => {
          const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
          WorkflowCanvasPanel.output.appendLine(`[${new Date().toISOString()}] ${msg.type} failed:\n${text}`)
          WorkflowCanvasPanel.output.show(true)
          void vscode.window.showErrorMessage(
            `Workflow action failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }),
      undefined,
      this.disposables,
    )

    // Live overlays: forward updates for the bound run (builder mode included, so ▶ Start actually
    // shows something), and auto-bind view-mode panels to a freshly started run of the same
    // workflow so clicking "Start" animates an already-open read-only canvas without a manual
    // "Open Canvas" step.
    this.disposables.push(
      deps.runService.onDidChangeRun(async (state) => {
        if (state.runId === this.runId) {
          void this.post({ type: 'runUpdate', runState: state })
          return
        }
        if (state.workflowName !== this.spec.name) return
        const bound = this.runId ? deps.runService.get(this.runId) : undefined
        if (bound && bound.startedAt >= state.startedAt) return
        this.runId = state.runId
        void this.post({ type: 'render', spec: this.spec, runState: state, agents: await this.collectAgents() })
      }),
    )

    // Discovery's background manifest scan may still be in flight when the panel first opens
    // (agents render as []); push the real list the moment it finishes so the builder/create
    // modal never gets stuck showing an empty agent picker.
    if (deps.discovered) {
      const discovered = deps.discovered
      this.disposables.push(
        discovered.onDidChangeTreeData(() => {
          if (!this.isBuilder) return
          void this.post({ type: 'agentsLoaded', agents: buildAgentSummaries(discovered) })
        }),
      )
    }

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables)
  }

  // ── Public static factory methods ──────────────────────────────────────────

  /** Open (or reuse) the canvas in VIEW mode for a spec, optionally bound to a run. */
  static render(
    deps: PanelDeps,
    spec: WorkflowSpec,
    runState?: RunState,
  ): void {
    if (WorkflowCanvasPanel.current) {
      const p = WorkflowCanvasPanel.current
      p.spec = spec
      p.isBuilder = false
      p.platform = undefined
      p.runId = runState?.runId
      p.panel.title = `Workflow: ${spec.name}`
      p.panel.reveal(vscode.ViewColumn.Active)
      const agents = deps.discovered ? buildAgentSummaries(deps.discovered) : []
      void p.post({ type: 'render', spec, runState, agents })
      return
    }
    WorkflowCanvasPanel.current = new WorkflowCanvasPanel(deps, spec, runState)
  }

  /** Open (or reuse) the canvas in BUILDER mode for a workflow id. */
  static async renderBuilder(
    deps: PanelDeps,
    workflowId: string,
    isReadOnly: boolean,
    createMode = false,
  ): Promise<void> {
    let spec: WorkflowSpec | undefined
    if (createMode || workflowId === NEW_WORKFLOW_ID) {
      // Create mode: the spec is a throwaway scaffold; the create-from-agents modal replaces it.
      spec = blankSpec('Untitled Workflow')
    } else if (deps.store) {
      spec = await deps.store.loadById(workflowId)
    }
    if (!spec) {
      void vscode.window.showErrorMessage(`Workflow "${workflowId}" not found.`)
      return
    }

    if (WorkflowCanvasPanel.current) {
      const p = WorkflowCanvasPanel.current
      p.spec = spec
      p.workflowId = workflowId
      p.isBuilder = true
      p.isReadOnly = isReadOnly
      p.createMode = createMode
      p.platform = undefined
      p.platformLink = undefined
      p.runId = undefined
      p.panel.title = isReadOnly ? `${spec.name} (read-only)` : `Builder: ${spec.name}`
      p.panel.reveal(vscode.ViewColumn.Active)
      // Paint immediately with local agents; fetch Foundry agents and the project link in the background.
      const agents = deps.discovered ? buildAgentSummaries(deps.discovered) : []
      void p.post({ type: 'renderBuilder', spec, isReadOnly, workflowId, agents, createMode, harnesses: harnessOptions() })
      void p.refreshFoundryAgents()
      void p.refreshPlatformLink()
      return
    }
    const instance = new WorkflowCanvasPanel(deps, spec, undefined)
    instance.workflowId = workflowId
    instance.isBuilder = true
    instance.isReadOnly = isReadOnly
    instance.createMode = createMode
    instance.panel.title = isReadOnly ? `${spec.name} (read-only)` : `Builder: ${spec.name}`
    WorkflowCanvasPanel.current = instance
  }

  /** Remember the deps panels need, for openers that have none (the platform Workflows view). */
  static useDefaults(deps: PanelDeps): void {
    WorkflowCanvasPanel.defaults = deps
  }

  /** Open (or reuse) the canvas on a project workflow from the SDLC platform, with its agent mapping. */
  static async renderPlatform(projectKey: string, workflowId: string, deps = WorkflowCanvasPanel.defaults): Promise<void> {
    if (!deps) {
      void vscode.window.showWarningMessage('The workflow canvas is not ready yet — try again in a moment.')
      return
    }
    const target = { projectKey, workflowId }
    const view = await loadPlatformView(target)
    if (!view) return
    const existing = WorkflowCanvasPanel.current
    const p = existing ?? new WorkflowCanvasPanel(deps, view.spec, undefined)
    WorkflowCanvasPanel.current = p
    p.spec = view.spec
    p.isBuilder = false
    p.isReadOnly = true
    p.createMode = false
    p.workflowId = undefined
    p.runId = undefined
    p.platform = target
    p.platformView = view
    p.panel.title = `${view.projectKey}: ${view.name}`
    p.panel.reveal(vscode.ViewColumn.Active)
    // A new panel renders on its 'ready'; an open one re-renders now.
    if (existing) void p.post({ type: 'renderPlatform', view })
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private readAiPreference(): AiAssistant {
    return vscode.workspace.getConfiguration('sdlcGovernance').get<AiAssistant>('aiAssistant', 'copilot')
  }

  private async onMessage(msg: WebviewToHost, initialRun: RunState | undefined): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        if (this.platform) {
          const view = this.platformView ?? (await loadPlatformView(this.platform))
          if (view) void this.post({ type: 'renderPlatform', view })
          return
        }
        if (this.isBuilder && this.workflowId !== undefined) {
          // Paint immediately with local agents; fetch Foundry agents in the background so a slow
          // or hanging Azure call can never block the builder from rendering.
          const agents = this.deps.discovered ? buildAgentSummaries(this.deps.discovered) : []
          void this.post({
            type: 'renderBuilder',
            spec: this.spec,
            isReadOnly: this.isReadOnly,
            workflowId: this.workflowId,
            agents,
            createMode: this.createMode,
            platformLink: this.platformLink,
            harnesses: harnessOptions(),
          })
          void this.refreshFoundryAgents()
          void this.refreshPlatformLink()
          void this.post({ type: 'aiPreferenceLoaded', assistant: this.readAiPreference() })
        } else {
          const runState = this.runId ? this.deps.runService.get(this.runId) ?? initialRun : initialRun
          void this.post({ type: 'render', spec: this.spec, runState, agents: await this.collectAgents() })
        }
        return
      }

      case 'revealNode':
        void this.revealNode(msg.nodeId)
        return

      case 'evaluateAgent':
        void vscode.commands.executeCommand('sdlcGovernance.evaluateAgent', msg.agentId)
        return

      case 'governAgent':
        void vscode.commands.executeCommand('sdlcGovernance.governAgent', msg.agentId)
        return

      case 'saveWorkflow': {
        if (this.isReadOnly) {
          void vscode.window.showWarningMessage('This workflow is read-only. Duplicate it to edit.')
          return
        }
        if (!this.deps.store) {
          void vscode.window.showWarningMessage('No workspace open — cannot save workflow.')
          return
        }
        try {
          await this.deps.store.save(msg.spec, msg.workflowId)
          this.spec = msg.spec
          if (!msg.silent) {
            void vscode.window.showInformationMessage(`Workflow "${msg.spec.name}" saved.`)
          }
          this.deps.workflowsView?.refresh()
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to save workflow: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return
      }

      case 'deleteWorkflow': {
        if (this.isReadOnly) {
          void vscode.window.showWarningMessage('This workflow is read-only and cannot be deleted.')
          return
        }
        if (!this.deps.store) {
          void vscode.window.showWarningMessage('No workspace open — cannot delete workflow.')
          return
        }
        // Unsaved scaffold (create mode): nothing on disk to delete — just close.
        if (msg.workflowId === NEW_WORKFLOW_ID) {
          this.dispose()
          return
        }
        const name = this.spec.name
        const ok = await vscode.window.showWarningMessage(
          `Delete workflow "${name}"? This cannot be undone.`,
          { modal: true },
          'Delete',
        )
        if (ok !== 'Delete') return
        try {
          await this.deps.store.delete(msg.workflowId)
          this.deps.workflowsView?.refresh()
          void vscode.window.showInformationMessage(`Deleted "${name}".`)
          this.dispose()
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return
      }

      case 'requestAgents': {
        const agents = await this.collectAgents(true)
        void this.post({ type: 'agentsLoaded', agents })
        return
      }

      case 'getAiPreference': {
        void this.post({ type: 'aiPreferenceLoaded', assistant: this.readAiPreference() })
        return
      }

      case 'setAiPreference': {
        await vscode.workspace.getConfiguration('sdlcGovernance')
          .update('aiAssistant', msg.assistant, vscode.ConfigurationTarget.Global)
        void this.post({ type: 'aiPreferenceLoaded', assistant: msg.assistant })
        return
      }

      case 'openRunAudit': {
        void vscode.commands.executeCommand('sdlcGovernance.openRunAudit')
        return
      }

      case 'approveRun': {
        const actor = await this.currentActor()
        await this.deps.runService.approve(msg.runId, actor, msg.comment)
        return
      }

      case 'rejectRun': {
        const actor = await this.currentActor()
        await this.deps.runService.reject(msg.runId, actor, msg.comment)
        return
      }

      case 'startWorkflow': {
        // Read-only specs (SDLC default) can still be run without saving.
        if (!this.isReadOnly && this.deps.store) {
          try {
            await this.deps.store.save(msg.spec, msg.workflowId)
            this.spec = msg.spec
            this.deps.workflowsView?.refresh()
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Failed to save before starting: ${err instanceof Error ? err.message : String(err)}`,
            )
            return
          }
        } else {
          this.spec = msg.spec
        }
        const where = await startLocalWorkflow(platformHandle()?.client(), {
          name: this.spec.name,
          isDefault: !!this.workflowId && isDefaultWorkflowId(this.workflowId),
        })
        if (where === 'builtin') await this.startGovernedRun()
        return
      }

      case 'setStepAgent': {
        await this.setStepAgent(msg.nodeId, msg.agentSlug)
        return
      }

      case 'setStepHarness': {
        await this.setStepHarness(msg.nodeId, msg.harness)
        return
      }

      case 'startPlatformWorkflow': {
        const target = this.platform
        const client = platformHandle()?.client()
        if (!target || !client) {
          void vscode.window.showWarningMessage('Sign in to the SDLC platform to start project workflows.')
          return
        }
        const project = (await client.projects()).find((p) => p.key === target.projectKey)
        if (!project) return
        const where = await startProjectWorkflow(client, {
          project,
          workflowId: target.workflowId,
          workflowName: this.platformView?.name ?? this.spec.name,
          offerBuiltin: true,
        })
        if (where === 'builtin') await this.startPlatformBuiltin(target)
        return
      }

      case 'openPlatformAgent': {
        if (this.platform) await openPlatformAgent(this.platform.projectKey, msg.slug)
        return
      }

      case 'refreshPlatform': {
        if (!this.platform) return
        const view = await loadPlatformView(this.platform)
        if (!view) return
        this.platformView = view
        this.spec = view.spec
        void this.post({ type: 'renderPlatform', view })
        return
      }

      case 'openPlatformWorkflow': {
        await WorkflowCanvasPanel.renderPlatform(msg.projectKey, msg.workflowId, this.deps)
        return
      }

      case 'openPlatformInBrowser': {
        if (this.platform) platformHandle()?.openInBrowser(`/projects/${this.platform.projectKey}/workflow`)
        return
      }

      case 'duplicateWorkflow': {
        if (!this.deps.store) {
          void vscode.window.showWarningMessage('No workspace open — cannot duplicate workflow.')
          return
        }
        const sourceId = msg.workflowId
        const sourceName = this.spec.name
        const newName = await vscode.window.showInputBox({
          prompt: 'Name for the duplicate workflow',
          value: `Copy of ${sourceName}`,
          validateInput: (v) => (v.trim() ? undefined : 'Name cannot be empty'),
        })
        if (!newName) return
        try {
          const newId = await this.deps.store.duplicate(sourceId, newName.trim())
          this.deps.workflowsView?.refresh()
          void vscode.window.showInformationMessage(`Created "${newName}". Opening builder…`)
          await WorkflowCanvasPanel.renderBuilder(this.deps, newId, false)
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Duplicate failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return
      }

      case 'newWorkflow': {
        await vscode.commands.executeCommand('sdlcGovernance.newWorkflow')
        return
      }

      case 'createWorkflow': {
        if (!this.deps.store) {
          void vscode.window.showWarningMessage('No workspace open — cannot create workflow.')
          return
        }
        const name = msg.spec.name.trim()
        const id =
          name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') + `-${Date.now()}`
        try {
          await this.deps.store.save(msg.spec, id)
          this.deps.workflowsView?.refresh()
          await WorkflowCanvasPanel.renderBuilder(this.deps, id, false)
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to create workflow: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private post(msg: HostToWebview): Thenable<boolean> {
    return this.panel.webview.postMessage(msg)
  }

  private async currentActor(): Promise<string> {
    return (await getAccountLabel(ARM_SCOPE)) ?? 'local-user'
  }

  /**
   * Seed inputs from the current spec's trigger (issue fetch + pick, or a manual task prompt) and
   * start a governed run on the RunService. Every agent node pauses for plan approval; the panel's
   * existing `onDidChangeRun` subscription (constructor) streams live overlays + approve/reject state
   * into the webview as the run proceeds — no explicit push needed here beyond binding `runId`.
   */
  private async startGovernedRun(): Promise<void> {
    const trigger = this.spec.nodes.find((n) => n.kind === 'trigger')
    const seeded = await seedRunInputs(trigger, {
      progress: (m) => void vscode.window.setStatusBarMessage(m, 4000),
      info: (m) => void vscode.window.showWarningMessage(m),
      askTask: async () =>
        (await vscode.window.showInputBox({
          prompt: 'Describe the task to seed the workflow',
          value: 'Describe the SDLC task…',
        })) || undefined,
      pickWorkItem: async (items) => {
        const picked = await vscode.window.showQuickPick(
          items.map((wi) => ({
            label: `#${wi.id} · ${wi.title}`,
            description: wi.state,
            detail: wi.description.slice(0, 120),
            wi,
          })),
          { placeHolder: 'Pick the work item to run this workflow against', matchOnDetail: true },
        )
        return picked?.wi
      },
    })
    if (!seeded) return
    // `ado` is a live connection (it holds a token callback), not run data — keep it out of the run's inputs,
    // which are persisted with the run. The dispatcher's default context reconnects Azure Boards itself.
    const inputs: Record<string, unknown> = { ...seeded }
    delete inputs.ado

    const actor = await this.currentActor()
    const state = await this.deps.runService.startRun(this.spec, actor, inputs)
    this.runId = state.runId
    void this.post({ type: 'render', spec: this.spec, runState: state, agents: await this.collectAgents() })
  }

  /** Change which agent runs a project workflow step (the API checks workflow.edit and the agent), then re-render. */
  private async setStepAgent(nodeId: string, agentSlug: string | null): Promise<void> {
    const target = this.platform
    const client = platformHandle()?.client()
    if (!target || !client) return
    void this.post({ type: 'platformBusy', nodeId })
    try {
      const res = await client.setStepAgent(target.projectKey, target.workflowId, nodeId, agentSlug)
      const step = this.spec.nodes.find((n) => n.id === nodeId)?.label ?? 'Step'
      void vscode.window.setStatusBarMessage(res.agentName ? `${step} now runs ${res.agentName}` : `${step} has no agent`, 3000)
      void vscode.commands.executeCommand('sdlcGovernance.platform.refreshCatalog')
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not change the step's agent: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Re-render from the server either way: on failure this resets the dropdown to what is really mapped.
    const view = await loadPlatformView(target)
    if (view) {
      this.platformView = view
      this.spec = view.spec
      void this.post({ type: 'renderPlatform', view })
    } else {
      void this.post({ type: 'platformBusy', nodeId: null })
    }
  }

  /** Pin a project workflow step to a harness (null = the run's own harness; the API checks workflow.edit), then re-render. */
  private async setStepHarness(nodeId: string, harness: string | null): Promise<void> {
    const target = this.platform
    const client = platformHandle()?.client()
    if (!target || !client) return
    void this.post({ type: 'platformBusy', nodeId })
    try {
      const res = await client.setStepHarness(target.projectKey, target.workflowId, nodeId, harness)
      const step = this.spec.nodes.find((n) => n.id === nodeId)?.label ?? 'Step'
      const label = res.harness ? (harnessOptions().find((h) => h.id === res.harness)?.label ?? res.harness) : undefined
      void vscode.window.setStatusBarMessage(label ? `${step} now runs in ${label}` : `${step} runs in the run's harness`, 3000)
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not change the step's harness: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Re-render from the server either way: on failure this resets the dropdown to what is really set.
    const view = await loadPlatformView(target)
    if (view) {
      this.platformView = view
      this.spec = view.spec
      void this.post({ type: 'renderPlatform', view })
    } else {
      void this.post({ type: 'platformBusy', nodeId: null })
    }
  }

  /** Run a project workflow on the built-in runtime (the user chose it over a harness): its agents come from the platform. */
  private async startPlatformBuiltin(target: PlatformTarget): Promise<void> {
    const client = platformHandle()?.client()
    if (!client) return
    const detail = await client.workflow(target.projectKey, target.workflowId)
    const slugs = [...new Set(detail.spec.nodes.flatMap((n) => (n.kind === 'agent' && n.data.agentId ? [n.data.agentId] : [])))]
    registerPlatformAgents(await Promise.all(slugs.map((slug) => client.agent(target.projectKey, slug))))
    this.platform = undefined
    this.spec = detail.spec
    await this.startGovernedRun()
  }

  /**
   * For the local default ("Story delivery"): the project workflow it corresponds to, when signed in and this
   * workspace's repository is linked to a project — the builder shows an "Agent mapping" link to it. Never prompts.
   */
  private async refreshPlatformLink(): Promise<void> {
    const workflowId = this.workflowId
    const client = platformHandle()?.client()
    if (!client || !workflowId || !isDefaultWorkflowId(workflowId)) return
    try {
      const project = await workspaceProject(await client.projects())
      if (!project) return
      const def = (await client.workflows(project.key)).find((w) => w.isDefault)
      if (!def || this.workflowId !== workflowId || !this.isBuilder) return
      this.platformLink = { projectKey: project.key, workflowId: def.id, name: def.name }
      const agents = await this.collectAgents()
      void this.post({
        type: 'renderBuilder',
        spec: this.spec,
        isReadOnly: this.isReadOnly,
        workflowId,
        agents,
        createMode: this.createMode,
        platformLink: this.platformLink,
        harnesses: harnessOptions(),
      })
    } catch {
      /* offline or no access — the builder simply shows no link */
    }
  }

  /** Merge file-discovered agents with Azure Foundry agents. Foundry results are cached per panel. */
  private async collectAgents(forceRefresh = false): Promise<AgentSummary[]> {
    const local = this.deps.discovered ? buildAgentSummaries(this.deps.discovered) : []
    if (this.deps.fetchFoundryAgents && (forceRefresh || this.foundryCache === undefined)) {
      try {
        this.foundryCache = await this.deps.fetchFoundryAgents()
      } catch {
        this.foundryCache = []
      }
    }
    return [...local, ...(this.foundryCache ?? [])]
  }

  /**
   * Fetch Foundry agents in the background and push the merged list to the webview via `agentsLoaded`.
   * Never throws — a slow or failing Azure call simply leaves the agent list as the local agents.
   */
  private async refreshFoundryAgents(): Promise<void> {
    if (!this.deps.fetchFoundryAgents || !this.isBuilder) return
    try {
      const agents = await this.collectAgents(true)
      void this.post({ type: 'agentsLoaded', agents })
    } catch {
      // ignore — local agents already rendered
    }
  }

  private async revealNode(nodeId: string): Promise<void> {
    const node = this.spec.nodes.find((n) => n.id === nodeId)
    const agentId = node?.data.agentId
    // A bare slug ("planner"): a platform agent in a project workflow, or a built-in agent in the local default.
    if (node?.kind === 'agent' && agentId && /^[a-z0-9-]+$/.test(agentId)) {
      if (this.platform) await openPlatformAgent(this.platform.projectKey, agentId)
      else await openBuiltinAgent(agentId)
      return
    }
    const match = agentId?.match(/^[^:]+:(.+?)#/)
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!match || !folder) {
      void vscode.window.showInformationMessage(`No source manifest linked to "${node?.label ?? nodeId}".`)
      return
    }
    const uri = vscode.Uri.joinPath(folder.uri, match[1])
    try {
      const doc = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(doc, { preview: true })
    } catch {
      void vscode.window.showWarningMessage(`Could not open ${match[1]}.`)
    }
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview')
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'))
    const n = nonce()
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
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
  <title>Workflow Canvas</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`
  }

  private dispose(): void {
    WorkflowCanvasPanel.current = undefined
    this.panel.dispose()
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Discovered agents, then the bundled built-ins (the default workflow's agents, bound by slug) not shadowed by one. */
function buildAgentSummaries(discovered: DiscoveredAgentsProvider): AgentSummary[] {
  const local = discoveredSummaries(discovered)
  const ids = new Set(local.map((a) => a.id))
  const builtins = listBuiltinAgents()
    .filter((a) => !ids.has(a.slug))
    .map((a): AgentSummary => ({ id: a.slug, name: a.name, description: a.description, sourceKind: 'builtin', instructions: a.instructions }))
  return [...local, ...builtins]
}

function discoveredSummaries(discovered: DiscoveredAgentsProvider): AgentSummary[] {
  return discovered.getAgents().map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    model: a.model,
    sourceKind: a.sourceKind,
    instructions: a.instructions,
    sourcePath: a.sourcePath,
    hasBundledScripts: a.hasBundledScripts,
  }))
}

/** Fetch a project workflow, the project and its agents into the view the webview renders. */
async function loadPlatformView(target: PlatformTarget): Promise<PlatformWorkflowView | undefined> {
  const handle = platformHandle()
  const client = handle?.client()
  if (!handle || !client) {
    void vscode.window.showWarningMessage('Connect to the SDLC platform to open project workflows.')
    return undefined
  }
  try {
    const [workflow, agents, projects] = await Promise.all([
      client.workflow(target.projectKey, target.workflowId),
      client.agents(target.projectKey),
      client.projects(),
    ])
    const project: ProjectSummary | undefined = projects.find((p) => p.key === target.projectKey)
    await handle.ensureMe()
    return {
      projectKey: target.projectKey,
      projectName: project?.name ?? target.projectKey,
      workflowId: workflow.id,
      name: workflow.name,
      version: workflow.version,
      isDefault: workflow.isDefault,
      spec: workflow.spec,
      canEdit: project ? canIn(handle, project, 'workflow.edit') : false,
      agents: agents
        .filter((a) => a.kind === 'agent')
        .map((a) => ({
          slug: a.slug,
          name: a.name,
          description: a.description,
          sdlcStage: a.sdlcStage,
          source: a.source,
          enabled: a.enabled,
          usable: a.usable,
        })),
      harnesses: harnessOptions(),
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not open the ${target.projectKey} workflow: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/** A platform agent's instructions as a read-only Markdown preview. */
async function openPlatformAgent(projectKey: string, slug: string): Promise<void> {
  const client = platformHandle()?.client()
  if (!client) return
  try {
    const a = await client.agent(projectKey, slug)
    const lines = [
      `# ${a.name}`,
      `> ${a.description}`,
      [
        `- **Source:** ${a.source === 'builtin' ? 'Built-in' : 'Codebase'}${a.sourcePath ? ` — \`${a.sourcePath}\`` : ''}`,
        `- **Stage:** ${a.sdlcStage} · **Enabled in ${projectKey}:** ${a.enabled ? 'yes' : 'no'}`,
        a.requiredRole ? `- **Requires:** ${PROJECT_ROLE_LABELS[a.requiredRole]} or above${a.usable ? '' : ' (locked for you)'}` : '',
        a.tools.length ? `- **Tools:** ${a.tools.map((t) => `\`${t}\``).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      '---',
      a.instructions,
    ]
    await showReadonlyMarkdown(`${projectKey}/agents/${a.slug}.md`, lines.join('\n\n'))
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not open agent "${slug}": ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A built-in agent (bundled with the extension, the default workflow's agents) as a read-only Markdown preview. */
async function openBuiltinAgent(slug: string): Promise<void> {
  const a = builtinAgentFile(slug)
  if (!a) {
    void vscode.window.showInformationMessage(`"${slug}" is not a built-in agent. Sign in to the SDLC platform to see project agents.`)
    return
  }
  const meta = [
    `- **Built-in agent** — \`${a.sourcePath}\``,
    `- **Stage:** ${a.sdlcStage}`,
    a.tools.length ? `- **Tools:** ${a.tools.map((t) => `\`${t}\``).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  await showReadonlyMarkdown(`builtin/agents/${a.slug}.md`, [`# ${a.name}`, `> ${a.description}`, meta, '---', a.instructions].join('\n\n'))
}
