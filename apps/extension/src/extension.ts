// Extension entry point — activation, command + view registration.
//
// The sidebar has three views, each made of sections (views/sectionedTreeProvider) backed by the providers below:
//   • Stories   — platform stories and each project's memory  (platform/registerPlatform)
//   • Agents    — project agents (platform catalog) · this workspace's discovered agents · evaluations ·
//                 Azure AI Foundry (projects, compliance)
//   • Workflows — project workflows with their agent mapping (platform) · local workflows · runs (with the
//                 evaluator scores behind every gate)
// Overall status (Azure, platform, discovery, last gate) lives in the status bar → "Show Status".

import * as vscode from 'vscode'
import { ARM_SCOPE, FOUNDRY_SCOPE } from './foundry/constants'
import { getSession, isSignedIn, getAccountLabel } from './auth/azureAuth'
import { SecretStore } from './secrets/secretStore'
import { FoundryProjectsProvider } from './views/foundryProjectsProvider'
import { DiscoveredAgentsProvider } from './views/discoveredAgentsProvider'
import { EvaluationResultsProvider } from './views/evaluationResultsProvider'
import { createDiagnostics } from './discovery/diagnostics'
import { ADAPTERS } from './discovery/adapters'
import { QUALITY_RULES_PATH } from './discovery/qualityConfig'
import { AuditStore } from './audit/auditStore'
import { registerEvalCommands } from './commands/registerEvalCommands'
import { initTracing, shutdownTracing } from './telemetry/tracing'
import { readTelemetrySettings } from './eval/settings'
import { RunAuditStore } from './runtime/runAudit'
import { MockWorkflowRuntime } from './runtime/mock/mockRuntime'
import { StubAgentDispatcher } from './runtime/mock/stubs'
import { createGateEvaluator } from './runtime/gate/gateWiring'
import { LmAgentDispatcher } from './runtime/dispatch/lmAgentDispatcher'
import { buildDefaultDispatchContext } from './runtime/dispatch/dispatchContext'
import { registerPlatform } from './platform/registerPlatform'
import type { PlatformHandle } from './platform/platformHandle'
import { PlatformAgentsProvider, PlatformRunsProvider, PlatformWorkflowsProvider } from './platform/platformCatalogProviders'
import { registerPlatformCatalog } from './platform/registerPlatformCatalog'
import { registerStoryEditing } from './platform/registerStoryEditing'
import { ExternalEngineDispatcher, RoutingDispatcher } from './runtime/dispatch/external/externalEngineDispatcher'
import { HarnessSessions } from './platform/session/harnessSessions'
import { RUN_MONITOR_VIEW, RunMonitorView } from './platform/runMonitor/runMonitorView'
import { presenceClientId } from './platform/presence'
import { autoInstallDefaultHarnesses, installDefaultHarnesses } from './platform/engines/autoInstall'
import { usePlatformAgentStore } from './platform/platformAgentRegistry'
import { registerReadonlyDocs } from './platform/readonlyDocs'
import { SectionedTreeProvider } from './views/sectionedTreeProvider'
import { LangGraphWorkflowRuntime } from './runtime/langgraph/langGraphRuntime'
import { FileBackedCheckpointSaver } from './runtime/langgraph/checkpointSaver'
import { RunMetaStore } from './runtime/langgraph/runMetaStore'
import type { AgentDispatcher, WorkflowRuntime } from './runtime/port'
import { registerWorkflowChatParticipant } from './chat/workflowChatParticipant'
import { prepareClaudeCodePrompt } from './chat/claudeCodeSeed'
import { RunService } from './runtime/runService'
import { RunsProvider } from './views/runsProvider'
import { registerRunCommands } from './commands/registerRunCommands'
import { registerWorkflowCommands } from './commands/registerWorkflowCommands'
import { WorkflowStore } from './runtime/workflowStore'
import { WorkflowsProvider } from './views/workflowsProvider'
import { getToken } from './auth/azureAuth'
import { listFoundryAgents, toAgentSummary } from './foundry/foundryAgents'
import { ControlPlaneProvider, AgentNode } from './views/controlPlaneProvider'
import { readContinuousEvalConfig, readLogAnalyticsConfig, readPurviewConfig } from './eval/settings'
import { classifyContent, buildClassificationRecord, PurviewClassificationStore } from './foundry/purview'
import {
  evaluateContinuous,
  inferenceTokensOf,
  runStatesToSamples,
  sampleRuns,
} from './eval/continuousEval'
import {
  buildAlertRecords,
  ContinuousAlertStore,
  notifyAlerts,
  pushAlertsToLogAnalytics,
} from './eval/alertSink'

let statusBar: vscode.StatusBarItem

export function activate(context: vscode.ExtensionContext): void {
  const secrets = new SecretStore(context.secrets)
  const foundryProjects = new FoundryProjectsProvider()

  // ─── Discovery engine (Phase 2) ────────────────────────────────────────────
  const diagnostics = createDiagnostics()
  const discoveredAgents = new DiscoveredAgentsProvider(diagnostics)
  context.subscriptions.push(diagnostics)

  // ─── Evaluation & governance gate (Phase 3) ────────────────────────────────
  const auditStore = new AuditStore(context.globalStorageUri)
  const evaluationResults = new EvaluationResultsProvider(auditStore)
  registerEvalCommands(context, { store: auditStore, results: evaluationResults, secrets })

  // ─── Orchestration runtime (Phase 4) ───────────────────────────────────────
  // Mock runtime now (in-process, zero Azure); FoundryWorkflowRuntime swaps in behind the same
  // WorkflowRuntime port after the P4.0 spike (see spike/phase4-orchestration + docs/adr/0002).
  const runAuditStore = new RunAuditStore(context.globalStorageUri)
  // Real LLM dispatch (vscode.lm / Copilot) by default; `mock` keeps the deterministic stub for
  // offline use and tests. The chat participant binds its run's context to the LM dispatcher; every other
  // run (canvas, commands) gets the default context — discovered agents, git and Azure Boards.
  const dispatchMode = vscode.workspace.getConfiguration('sdlcGovernance').get<string>('dispatch.mode', 'lm')
  const lmDispatcher = new LmAgentDispatcher()
  lmDispatcher.setDefaultContext(buildDefaultDispatchContext)
  const dispatcher: AgentDispatcher = dispatchMode === 'mock' ? new StubAgentDispatcher() : lmDispatcher
  // Runs started in a harness (Copilot, Claude Code, Codex…) hand their agent steps to that harness through the SDLC
  // tools; every other run keeps the dispatcher above.
  const externalDispatcher = new ExternalEngineDispatcher()
  const routedDispatcher = new RoutingDispatcher(externalDispatcher, dispatcher)
  // The in-run gate: Foundry evaluators + `decideGate` when a project is configured (mode `auto`, the default),
  // else the offline stub — see runtime/gate. Every real evaluation lands in the audit store + Evaluation Results.
  const gate = createGateEvaluator({
    auditStore,
    results: evaluationResults,
    getAppInsightsSecret: (key) => secrets.get(key),
  })
  // 'langgraph' (default) is the real @langchain/langgraph StateGraph engine (specToStateGraph.ts) with durable
  // interrupt()-based HITL, streamed per-step progress, and runs that survive a window reload. 'interpreter'
  // keeps the hand-rolled FIFO interpreter — a fast rollback if a LangGraph edge case surfaces. The engine is
  // chosen once at activation, so a change prompts for a reload (below).
  const runtimeEngine = vscode.workspace.getConfiguration('sdlcGovernance').get<string>('runtime.engine', 'langgraph')
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('sdlcGovernance.runtime.engine')) return
      const now = vscode.workspace.getConfiguration('sdlcGovernance').get<string>('runtime.engine', 'langgraph')
      if (now === runtimeEngine) return
      void vscode.window
        .showInformationMessage(
          `The workflow engine changed to "${now}". Reload the window to apply it.`,
          'Reload Window',
        )
        .then((choice) => {
          if (choice === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow')
        })
    }),
  )
  const workflowRuntime: WorkflowRuntime =
    runtimeEngine === 'langgraph'
      ? new LangGraphWorkflowRuntime({
          dispatcher: routedDispatcher,
          gate,
          checkpointer: new FileBackedCheckpointSaver(context.globalStorageUri),
          runMeta: new RunMetaStore(context.globalStorageUri),
        })
      : new MockWorkflowRuntime({ dispatcher: routedDispatcher, gate })
  const runService = new RunService(workflowRuntime, runAuditStore)
  // Specs and platform agents outlive a reload, so restored runs still open on the canvas and resolve their agents.
  runService.persistSpecsIn(context.globalState)
  usePlatformAgentStore(context.globalState)
  // A finished run's dispatch binding (resolver, files written) is no longer needed.
  context.subscriptions.push(
    runService.onDidChangeRun((state) => {
      if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
        lmDispatcher.releaseRun(state.runId)
      }
    }),
  )
  // Bring back runs that outlived the last session (paused on a plan approval, or interrupted mid-step) so they
  // appear in the Runs tree and can be approved. A no-op for the interpreter, which has no durable store.
  void runService.restore().catch((err) => {
    console.error('[sdlc] could not restore previous runs:', err)
  })

  // ─── SDLC platform backend (Platform Stories view) ─────────────────────────
  // Same projects and stories as the web app. Inert until sdlcGovernance.platform.apiUrl is set.
  registerReadonlyDocs(context)
  const platform = registerPlatform(context, {
    runs: runService,
    extensionUri: context.extensionUri,
    onDidWriteFile: dispatchMode === 'mock' ? undefined : lmDispatcher.onDidWriteFile,
  })
  // The platform rows of the Agents and Workflows views: the project's agent catalog and its workflows.
  const platformAgents = new PlatformAgentsProvider(platform)
  const platformWorkflows = new PlatformWorkflowsProvider(platform)
  const platformRuns = new PlatformRunsProvider(platform)
  context.subscriptions.push(platformAgents, platformWorkflows, platformRuns)
  registerPlatformCatalog(context, { platform, agents: platformAgents, workflows: platformWorkflows, runs: platformRuns })
  registerStoryEditing(context, platform)

  // ─── Runs in the user's harness (started from the web or from VS Code) ─────
  const harnessSessions = new HarnessSessions({
    context,
    platform,
    runs: runService,
    external: externalDispatcher,
    clientId: () => presenceClientId(context),
    log: (m) => console.log(`[sdlc] ${m}`),
  })
  // The Run monitor: your workflow runs, live (the same agent map as the web's run monitor).
  const runMonitor = new RunMonitorView(context, platform)
  context.subscriptions.push(runMonitor, vscode.window.registerWebviewViewProvider(RUN_MONITOR_VIEW, runMonitor, { webviewOptions: { retainContextWhenHidden: true } }))
  // Claude Code and Codex come with this extension (an extension pack); install any that are missing.
  const harnessLog = (m: string) => console.log(`[sdlc] ${m}`)
  context.subscriptions.push(
    autoInstallDefaultHarnesses(context, harnessLog),
    vscode.commands.registerCommand('sdlcGovernance.installDefaultHarnesses', () => installDefaultHarnesses(context, harnessLog, true)),
  )
  context.subscriptions.push(
    harnessSessions,
    vscode.commands.registerCommand(
      'sdlcGovernance.platform.startInHarness',
      (story?: import('@sdlc/contracts').Story, workflowId?: string, engine?: string, taskNumber?: number | null) =>
        story && workflowId && engine ? harnessSessions.startLocal(story, workflowId, engine, taskNumber) : undefined,
    ),
  )

  // ─── `@sdlc` chat participant (issue trigger → pick → live agent run) ───────
  context.subscriptions.push(
    registerWorkflowChatParticipant({ runs: runService, dispatcher: lmDispatcher }),
    vscode.commands.registerCommand('sdlcGovernance.startWorkflowChat', async (name?: string) => {
      const assistant = vscode.workspace.getConfiguration('sdlcGovernance').get<string>('aiAssistant', 'copilot')
      const workflowArg = typeof name === 'string' ? name : ''
      if (assistant === 'claude-code') {
        await runClaudeCodeWorkflow(workflowArg)
      } else if (assistant === 'codex') {
        await runCodexWorkflow(workflowArg)
      } else {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: `@sdlc ${workflowArg}`.trimEnd() + ' ',
        })
      }
    }),
  )
  const runsView = new RunsProvider(runService)
  registerRunCommands(context, {
    runs: runService,
    audit: runAuditStore,
    extensionUri: context.extensionUri,
    reveal: () => void vscode.commands.executeCommand('sdlcGovernance.workflows.focus'),
  })

  // ─── Workflow builder (Phase 5B) ───────────────────────────────────────────
  // Users build workflows from their own discovered + Foundry agents. We stopped seeding the old mock
  // SDLC pipeline (its placeholder agent nodes never resolved to real agents), but the "SDLC Governance"
  // template below references REAL agent ids from this repo's .claude/agents/ files, so it's seeded once
  // as an ordinary, editable "My Workflows" entry (not the same mistake).
  const workflowStore =
    WorkflowStore.forActiveWorkspace(context.globalState) ??
    new WorkflowStore(context.globalStorageUri, context.globalState)
  void workflowStore.seedGovernanceTemplate()
  const workflowsView = new WorkflowsProvider(workflowStore)
  registerWorkflowCommands(context, {
    store: workflowStore,
    discovered: discoveredAgents,
    workflowsView,
    runs: runService,
    extensionUri: context.extensionUri,
    fetchFoundryAgents: async () => (await listFoundryAgents(getToken)).map(toAgentSummary),
  })

  // ─── Continuous evaluation (Phase 5D) ──────────────────────────────────────
  // Re-scores a sample of recent runs and alerts on quality regressions / eval-spend overruns.
  // Append-only alert log + optional Log Analytics mirror + a VS Code notification.
  const continuousAlerts = new ContinuousAlertStore(context.globalStorageUri)
  context.subscriptions.push(
    vscode.commands.registerCommand('sdlcGovernance.runContinuousEval', async () => {
      const cfg = readContinuousEvalConfig()
      const finished = runService.list().filter((r) => r.status === 'completed' || r.status === 'failed')
      const samples = runStatesToSamples(finished)
      if (samples.length === 0) {
        void vscode.window.showInformationMessage(
          'Continuous eval: no completed runs with gate results to sample yet.',
        )
        return
      }
      const sampled = sampleRuns(samples, cfg.sampleRate, cfg.minSamples)
      const sampledRuns = finished.filter((r) => sampled.some((s) => s.runId === r.runId))
      const report = evaluateContinuous(sampled, cfg, inferenceTokensOf(sampledRuns))

      if (report.alerts.length === 0) {
        void vscode.window.showInformationMessage(
          `Continuous eval: ${report.sampledCount} run(s) sampled, no alerts.`,
        )
        return
      }
      const records = buildAlertRecords(report.alerts, new Date().toISOString())
      await continuousAlerts.append(records)
      try {
        await pushAlertsToLogAnalytics(records, readLogAnalyticsConfig(), getToken)
      } catch (err) {
        void vscode.window.showWarningMessage(
          `Continuous eval: alert SIEM push failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      notifyAlerts(report.alerts)
    }),

    vscode.commands.registerCommand('sdlcGovernance.openContinuousEvalAlerts', async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(continuousAlerts.uri)
        await vscode.window.showTextDocument(doc)
      } catch {
        void vscode.window.showInformationMessage('No continuous-eval alerts logged yet.')
      }
    }),
  )

  // ─── Foundry Control Plane (Phase 5B) ──────────────────────────────────────
  // Fleet inventory + guardrail compliance + remediation. Degrades to an explicit "backend not
  // enabled" state while the server-side Foundry spike (Unknown A) is unresolved.
  const controlPlane = new ControlPlaneProvider()
  context.subscriptions.push(
    vscode.commands.registerCommand('sdlcGovernance.refreshControlPlane', () => controlPlane.refresh()),

    vscode.commands.registerCommand('sdlcGovernance.remediateAgent', async (node?: AgentNode) => {
      if (!node) {
        void vscode.window.showInformationMessage('Select a non-compliant agent to remediate.')
        return
      }
      const ok = await vscode.window.showWarningMessage(
        `Apply the active guardrail policy to ${node.entry.agent.name} v${node.entry.agent.version}?`,
        { modal: true },
        'Apply',
      )
      if (ok !== 'Apply') return
      try {
        const done = await controlPlane.remediate(node.entry)
        if (!done) {
          void vscode.window.showWarningMessage('Control Plane backend not available — cannot remediate.')
          return
        }
        controlPlane.refresh()
        void vscode.window.showInformationMessage(`Remediated ${node.entry.agent.name}.`)
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Remediation failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }),

    vscode.commands.registerCommand('sdlcGovernance.remediateNonCompliant', async () => {
      const targets = controlPlane.nonCompliantEntries()
      if (!controlPlane.canRemediate() || targets.length === 0) {
        void vscode.window.showInformationMessage('Nothing to remediate.')
        return
      }
      // Org policy requires confirmation before fleet-wide writes (managed-settings rule).
      const ok = await vscode.window.showWarningMessage(
        `Apply the active guardrail policy to ${targets.length} non-compliant agent(s)?`,
        { modal: true },
        'Apply to all',
      )
      if (ok !== 'Apply to all') return
      let failed = 0
      for (const entry of targets) {
        try {
          await controlPlane.remediate(entry)
        } catch {
          failed++
        }
      }
      controlPlane.refresh()
      void vscode.window.showInformationMessage(
        `Bulk remediation: ${targets.length - failed} succeeded, ${failed} failed.`,
      )
    }),
  )

  // ─── Purview classification (Phase 5C, preview/optional) ───────────────────
  // Classifies content for PII/SIT (Purview when enabled+reachable, else a local heuristic) and
  // records the verdict in an append-only store.
  const purviewStore = new PurviewClassificationStore(context.globalStorageUri)
  context.subscriptions.push(
    vscode.commands.registerCommand('sdlcGovernance.classifyContent', async () => {
      const editor = vscode.window.activeTextEditor
      const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined
      const text =
        selection ??
        (await vscode.window.showInputBox({ prompt: 'Content to classify for PII/SIT' })) ??
        undefined
      if (!text) return
      const classification = await classifyContent(text, readPurviewConfig(), getToken)
      const record = buildClassificationRecord(classification, new Date().toISOString())
      await purviewStore.append(record)
      const summary = classification.sensitive
        ? classification.types.map((t) => `${t.type}×${t.count}`).join(', ')
        : 'no sensitive types detected'
      void vscode.window.showInformationMessage(
        `Classification (${classification.source}): ${summary}. Recorded to the Purview log.`,
      )
    }),
  )

  // ─── Status (was the Overview view): sign-in, platform, discovery count, last gate ─────
  const status = { discovery: discoveredAgents, audit: auditStore, platform }
  const refreshStatus = (): void => void updateStatusBar(status)
  context.subscriptions.push(
    discoveredAgents.onDidChangeTreeData(refreshStatus),
    auditStore.onDidAppend(refreshStatus),
    platform.onDidChangeConnection(refreshStatus),
  )

  // Initialize OTEL → App Insights tracing if enabled (lazy; no-op otherwise).
  void readTelemetrySettings((key) => secrets.get(key)).then((t) =>
    initTracing({ enabled: t.enabled, connectionString: t.connectionString, recordContent: t.recordContent }),
  )

  // ─── Views: Agents and Workflows (Stories is registered by registerPlatform) ─────
  const agentsTree = new SectionedTreeProvider([
    {
      id: 'project-agents',
      label: 'Project agents',
      icon: 'organization',
      provider: platformAgents,
      describe: () => (platform.client() ? undefined : 'not connected'),
    },
    {
      id: 'workspace-agents',
      label: 'This workspace',
      icon: 'folder-library',
      provider: discoveredAgents,
      describe: () => (discoveredAgents.scanned ? `${discoveredAgents.count}` : 'scanning…'),
      empty: {
        label: 'No agent files found — scan for .claude/agents, SKILL.md, AGENTS.md…',
        icon: 'search',
        command: { command: 'sdlcGovernance.discover', title: 'Discover Agents' },
      },
    },
    {
      id: 'evaluations',
      label: 'Evaluations',
      icon: 'beaker',
      provider: evaluationResults,
      collapsed: true,
      empty: {
        label: 'No evaluations yet — Govern & Evaluate an agent',
        icon: 'beaker',
        command: { command: 'sdlcGovernance.governAndEvaluate', title: 'Govern & Evaluate' },
      },
    },
    {
      id: 'azure',
      label: 'Azure AI Foundry',
      icon: 'azure',
      collapsed: true,
      describe: () => azureAccount ?? 'not signed in',
      sections: [
        {
          id: 'foundry-projects',
          label: 'Projects',
          icon: 'cloud',
          provider: foundryProjects,
          empty: { label: 'Sign in to Azure to list Foundry projects', icon: 'sign-in', command: { command: 'sdlcGovernance.signIn', title: 'Sign in to Azure' } },
        },
        { id: 'compliance', label: 'Compliance', icon: 'shield', provider: controlPlane, collapsed: true },
      ],
    },
  ])
  const workflowsTree = new SectionedTreeProvider([
    {
      id: 'project-workflows',
      label: 'Project workflows',
      icon: 'organization',
      provider: platformWorkflows,
      describe: () => (platform.client() ? undefined : 'not connected'),
    },
    { id: 'local-workflows', label: 'Built-in workflows', icon: 'lock', provider: workflowsView },
    {
      id: 'runs',
      label: 'Runs',
      icon: 'play-circle',
      provider: runsView,
      describe: () => {
        const active = runService.list().filter((r) => r.status === 'running' || r.status === 'awaiting_approval' || r.status === 'queued').length
        return active ? `${active} active` : undefined
      },
    },
    {
      // Every run reported in the project (all developers) — the web app's Workflow › Runs tab.
      id: 'project-runs',
      label: 'Project runs',
      icon: 'history',
      provider: platformRuns,
      collapsed: true,
      describe: () => (platform.client() ? undefined : 'not connected'),
    },
  ])
  const agentsTreeView = vscode.window.createTreeView('sdlcGovernance.agents', { treeDataProvider: agentsTree, showCollapseAll: true })
  context.subscriptions.push(
    agentsTree,
    workflowsTree,
    agentsTreeView,
    vscode.window.createTreeView('sdlcGovernance.workflows', { treeDataProvider: workflowsTree, showCollapseAll: true }),
    // Where evaluation commands land when they finish: Agents › Evaluations, expanded.
    vscode.commands.registerCommand('sdlcGovernance.showEvaluations', async () => {
      await vscode.commands.executeCommand('sdlcGovernance.agents.focus')
      const section = agentsTree.section('evaluations')
      if (section) await agentsTreeView.reveal(section, { expand: true, focus: false, select: false })
    }),
    // Section descriptions ("3", "not connected", "1 active") follow their data.
    platform.onDidChangeConnection(() => {
      agentsTree.refresh('project-agents')
      workflowsTree.refresh('project-workflows')
      workflowsTree.refresh('project-runs')
    }),
    vscode.commands.registerCommand('sdlcGovernance.refreshAgentsView', async () => {
      platformAgents.refresh()
      controlPlane.refresh()
      foundryProjects.refresh()
      await discoveredAgents.refresh()
    }),
  )
  // Refresh the Control Plane on sign-in/out so the fleet reflects the active identity.
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'microsoft') controlPlane.refresh()
    }),
  )

  // ─── Auto-discover: initial scan, workspace changes, debounced file watch ───
  void discoveredAgents.refresh()
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void discoveredAgents.refresh()),
  )
  // Manifest globs + the quality-rules criteria file: any change re-scans so
  // suggestions stay in sync with the user's tuned rules.
  const watchGlobs = new Set([...ADAPTERS.flatMap((a) => a.globs), QUALITY_RULES_PATH])
  for (const glob of watchGlobs) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${glob}`)
    const onChange = () => discoveredAgents.scheduleRefresh()
    watcher.onDidCreate(onChange)
    watcher.onDidChange(onChange)
    watcher.onDidDelete(onChange)
    context.subscriptions.push(watcher)
  }

  // ─── Status bar ──────────────────────────────────────────────────────────
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'sdlcGovernance.helloWorld'
  context.subscriptions.push(statusBar)
  void updateStatusBar(status).then(() => agentsTree.refresh('azure'))

  // React to external sign-in/out and secret changes.
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'microsoft') {
        void updateStatusBar(status).then(() => agentsTree.refresh('azure'))
      }
    }),
    secrets.onDidChange(refreshStatus),
  )

  // ─── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    // "Show Status": what the Overview view used to list, as a menu of the account actions.
    vscode.commands.registerCommand('sdlcGovernance.helloWorld', async () => {
      const signedIn = await isSignedIn(ARM_SCOPE)
      const account = signedIn ? await getAccountLabel(ARM_SCOPE) : undefined
      const me = await platform.ensureMe()
      const lastGate = (await auditStore.readRecent(1))[0]
      type Item = vscode.QuickPickItem & { command?: string }
      const items: Item[] = [
        { label: 'Azure', kind: vscode.QuickPickItemKind.Separator },
        signedIn
          ? { label: `$(pass) Signed in as ${account ?? 'Azure user'}`, description: 'Sign out', command: 'sdlcGovernance.signOut' }
          : { label: '$(sign-in) Sign in to Azure', description: 'Foundry projects, evaluations, compliance', command: 'sdlcGovernance.signIn' },
        { label: '$(trash) Clear stored connection', command: 'sdlcGovernance.clearConnection' },
        { label: 'SDLC platform', kind: vscode.QuickPickItemKind.Separator },
        platform.client()
          ? { label: `$(plug) Connected${me ? ` as ${me.user.displayName}` : ''}`, description: 'Disconnect', command: 'sdlcGovernance.platform.disconnect' }
          : { label: '$(plug) Connect to the SDLC platform', description: 'Stories, project agents & workflows, memory', command: 'sdlcGovernance.platform.connect' },
        { label: 'Governance', kind: vscode.QuickPickItemKind.Separator },
        {
          label: `$(search) ${discoveredAgents.scanned ? `${discoveredAgents.count} agent${discoveredAgents.count === 1 ? '' : 's'} discovered` : 'Agents not scanned yet'}`,
          description: 'Re-scan',
          command: 'sdlcGovernance.discover',
        },
        {
          label: lastGate
            ? `${lastGate.gateDecision === 'pass' ? '$(pass)' : '$(error)'} Last gate: ${lastGate.gateDecision.toUpperCase()} · ${lastGate.step}`
            : '$(beaker) No evaluations yet',
          description: lastGate ? new Date(lastGate.timestamp).toLocaleString() : 'Govern & Evaluate',
          command: lastGate ? 'sdlcGovernance.openEvaluationResults' : 'sdlcGovernance.governAndEvaluate',
        },
      ]
      // Not awaited: the command returns once the menu is up (callers and tests don't block on a pick).
      void vscode.window.showQuickPick(items, { title: 'SDLC Governance' }).then((picked) => {
        if (picked?.command) void vscode.commands.executeCommand(picked.command)
      })
    }),

    vscode.commands.registerCommand('sdlcGovernance.signIn', async () => {
      try {
        // Acquire both audiences up front so later calls are silent.
        const arm = await getSession(ARM_SCOPE, true)
        if (!arm) {
          void vscode.window.showWarningMessage('Azure sign-in was cancelled.')
          return
        }
        await getSession(FOUNDRY_SCOPE, true)
        void vscode.window.showInformationMessage(`Signed in to Azure as ${arm.account.label}.`)
        await updateStatusBar(status)
        agentsTree.refresh('azure')
        foundryProjects.refresh()
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Azure sign-in failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }),

    vscode.commands.registerCommand('sdlcGovernance.signOut', async () => {
      // VS Code manages session removal from the Accounts menu; we can only
      // guide the user there and refresh our view state.
      void vscode.window.showInformationMessage(
        'To sign out, use the Accounts menu (bottom-left) → Microsoft → Sign Out. Views will refresh automatically.',
      )
      await updateStatusBar(status)
      agentsTree.refresh('azure')
    }),

    vscode.commands.registerCommand('sdlcGovernance.refreshFoundryProjects', () => {
      foundryProjects.refresh()
    }),

    vscode.commands.registerCommand('sdlcGovernance.discover', async () => {
      await discoveredAgents.refresh()
    }),

    vscode.commands.registerCommand('sdlcGovernance.clearConnection', async () => {
      await secrets.clear()
      refreshStatus()
      foundryProjects.refresh()
      void vscode.window.showInformationMessage('Stored SDLC Governance connection cleared.')
    }),
  )
}

/** The signed-in Azure account, for the "Azure AI Foundry" section's description. */
let azureAccount: string | undefined

interface StatusSources {
  discovery: { scanned: boolean; count: number }
  audit: AuditStore
  platform: PlatformHandle
}

/** The status bar item replaces the old Overview view: one glance, details in the tooltip, actions on click. */
async function updateStatusBar(src: StatusSources): Promise<void> {
  const signedIn = await isSignedIn(ARM_SCOPE)
  // Drive `when` clauses for the title-bar buttons.
  await vscode.commands.executeCommand('setContext', 'sdlcGovernance.signedIn', signedIn)
  azureAccount = signedIn ? ((await getAccountLabel(ARM_SCOPE)) ?? 'signed in') : undefined
  const connected = Boolean(src.platform.client())
  const me = src.platform.me()
  const lastGate = (await src.audit.readRecent(1))[0]

  statusBar.text = `$(shield) SDLC${lastGate && lastGate.gateDecision === 'fail' ? ' $(error)' : ''}`
  const md = new vscode.MarkdownString(undefined, true)
  md.appendMarkdown('**SDLC Agent Governance**\n\n')
  md.appendMarkdown(`$(azure) Azure: ${azureAccount ?? 'not signed in'}\n\n`)
  md.appendMarkdown(`$(plug) Platform: ${connected ? `connected${me ? ` as ${me.user.displayName}` : ''}` : 'not connected'}\n\n`)
  md.appendMarkdown(`$(search) Discovered agents: ${src.discovery.scanned ? src.discovery.count : 'not scanned yet'}\n\n`)
  md.appendMarkdown(
    `$(beaker) Last gate: ${lastGate ? `${lastGate.gateDecision.toUpperCase()} · ${lastGate.step} · ${new Date(lastGate.timestamp).toLocaleString()}` : 'no evaluations yet'}\n\n`,
  )
  md.appendMarkdown('_Click for actions_')
  statusBar.tooltip = md
  statusBar.show()
}

/**
 * Ensure a VS Code extension is installed, offering to install it from the Marketplace if it
 * isn't. Returns true once the extension is present (already was, or was just installed).
 */
async function ensureExtensionInstalled(extensionId: string, displayName: string): Promise<boolean> {
  if (vscode.extensions.getExtension(extensionId)) return true
  const choice = await vscode.window.showInformationMessage(
    `${displayName} isn't installed yet. Install it now?`,
    'Install',
    'Cancel',
  )
  if (choice !== 'Install') return false
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Installing ${displayName}…` },
    () => vscode.commands.executeCommand('workbench.extensions.installExtension', extensionId),
  )
  if (!vscode.extensions.getExtension(extensionId)) {
    vscode.window.showErrorMessage(`Could not install ${displayName}. Install it manually from the Marketplace.`)
    return false
  }
  return true
}

/** Workspace-relative path the seeded Claude Code prompt is written to before the run. */
const CLAUDE_PROMPT_REL_PATH = '.sdlc/claude-prompt.md'

/**
 * Open the selected workflow in the Claude Code VS Code extension panel (no terminal). The Claude
 * Code extension exposes no command API, but it registers a URI handler —
 * `vscode://anthropic.claude-code/open?prompt=…` — that opens its chat panel with a pre-filled
 * prompt (the user presses Enter to start; Anthropic's API never auto-submits). We seed the
 * workflow (resolve it, fetch + pick the assigned Azure Boards work item, bundle the agents'
 * instructions), write that compiled prompt to a file, then open the panel with a short seed that
 * points Claude Code at the file. Writing to a file keeps the URI short and dodges its length
 * limits. See https://code.claude.com/docs/en/vs-code.md ("Launch a VS Code tab from other tools").
 */
async function runClaudeCodeWorkflow(workflowArg: string): Promise<void> {
  if (!(await ensureExtensionInstalled('anthropic.claude-code', 'Claude Code'))) return

  const prompt = await prepareClaudeCodePrompt(workflowArg)
  if (!prompt) return // user cancelled a picker or no workspace — prepareClaudeCodePrompt already messaged

  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    vscode.window.showWarningMessage('Open a workspace folder first — the workflow runs in its root.')
    return
  }

  // Write the (potentially long, multi-line) compiled prompt to a file so the panel URI stays short.
  // Overwritten each run.
  const promptUri = vscode.Uri.joinPath(folder.uri, CLAUDE_PROMPT_REL_PATH)
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(promptUri, '..'))
    await vscode.workspace.fs.writeFile(promptUri, new TextEncoder().encode(prompt))
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not write the workflow prompt (${err instanceof Error ? err.message : String(err)}).`,
    )
    return
  }

  // Open the Claude Code extension panel pre-filled with a short seed that points it at the file.
  // The relative path resolves against the workspace root Claude Code runs in.
  const seed =
    `Read ${CLAUDE_PROMPT_REL_PATH} and run it as the SDLC orchestrator: work through each step ` +
    `in order, delegating to the named agent for each step. Start by triaging the issue and ` +
    `fetching the user stories.`
  // Claude Code's own `/open` URI handler just forwards to this command internally
  // (`claude-vscode.primaryEditor.open`). Call it directly so the panel opens in-process, in the
  // current window — routing through `openExternal`/the OS URI dispatcher instead can pop an
  // "allow this to open VS Code" confirmation and isn't guaranteed to land back in this window.
  try {
    await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', undefined, seed)
  } catch {
    // Command missing (older/newer Claude Code build) — fall back to the URI handler.
    const uri = vscode.Uri.parse('vscode://anthropic.claude-code/open?prompt=' + encodeURIComponent(seed))
    try {
      const opened = await vscode.env.openExternal(uri)
      if (!opened) {
        vscode.window.showErrorMessage(
          'Could not open the Claude Code extension. Make sure the Claude Code extension is installed.',
        )
        return
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not open the Claude Code extension (${err instanceof Error ? err.message : String(err)}). ` +
          'Make sure the Claude Code extension is installed.',
      )
      return
    }
  }
  vscode.window.showInformationMessage(
    'Opened Claude Code with the workflow pre-filled — press Enter in its chat to start the SDLC orchestrator.',
  )
}

/**
 * Open the selected workflow via the Codex VS Code extension (`openai.chatgpt`, no terminal). Unlike
 * Claude Code, Codex exposes no public URI/command for pre-filling its chat panel, so the best we can
 * do is compile the same seed prompt, copy it to the clipboard, and surface the extension's own view
 * on a best-effort basis so the user can paste it in.
 */
async function runCodexWorkflow(workflowArg: string): Promise<void> {
  if (!(await ensureExtensionInstalled('openai.chatgpt', 'Codex'))) return

  const prompt = await prepareClaudeCodePrompt(workflowArg)
  if (!prompt) return

  await vscode.env.clipboard.writeText(prompt)

  // Codex's exact reveal-sidebar command ID isn't documented and can vary by extension version, so
  // discover it instead of hardcoding a guess that silently no-ops when it doesn't match.
  const allCommands = await vscode.commands.getCommands(true)
  const revealCmd = allCommands.find((id) => /chatgpt|codex/i.test(id) && /sidebar|focus|open/i.test(id))
  let revealed = false
  if (revealCmd) {
    try {
      await vscode.commands.executeCommand(revealCmd)
      revealed = true
    } catch {
      // Found a plausible command id but it failed to execute — fall through to the manual message.
    }
  }

  vscode.window.showInformationMessage(
    revealed
      ? 'Codex is ready — your workflow prompt is copied to the clipboard. Paste it into the Codex chat panel.'
      : 'Your workflow prompt is copied to the clipboard. Open the Codex sidebar manually (Command Palette → ' +
          '"Codex: Open Codex Sidebar") and paste it in.',
  )
}

export function deactivate(): void {
  // Flush any buffered telemetry spans; subscriptions are disposed by VS Code.
  void shutdownTracing()
}
