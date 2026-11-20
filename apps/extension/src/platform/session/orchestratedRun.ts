// An orchestrator-driven run hosted in this window. The platform's orchestrator runs the workflow and hands each
// agent step to the harness pinned to it, so one run may need several harnesses (plan in Claude Code, implement in
// Copilot…). This window never runs the graph: per harness it serves the SDLC tools on the local bridge (backed by
// a RemoteStepSource that proxies them to the platform), writes the harness's wiring and protocol file, and opens
// the harness lazily — when the platform says a step is waiting for it (`run.step`) and it is not already polling.
// It also offers the run's approvals in VS Code and ends the session when the run is over.

import * as vscode from 'vscode'
import {
  harnessLabel,
  RUN_STATUS_LABELS,
  type HarnessTier,
  type NextStep,
  type PendingApproval,
  type PlatformEvent,
  type ProjectRunDetail,
  type RunLaunch,
  type StepAssignment,
  type StoryRunStatus,
} from '@sdlc/contracts'
import type { SkillRef } from '../../runtime/dispatch/external/stepChannel'
import type { BridgeEndpoints, LocalBridge } from '../bridge/localBridge'
import { findHarness, launch, reportsFilesViaHooks, skillsDirFor, wiringFor, type Harness } from '../engines/registry'
import { launchPrompt, nextFile, orchestratorMarkdown, protocolFile, type OrchestratorInput } from '../engines/orchestratorPrompt'
import type { PlatformClient } from '../platformClient'
import type { ActivityReporter } from './activityReporter'
import { CheckpointPump, parseDone } from './checkpointPump'
import { harnessRuns } from './harnessRunInfo'
import { RemoteStepSource, type CompletingStep } from './remoteSteps'
import { buildSdlcTools } from './sdlcTools'
import type { SessionFiles } from './sessionFiles'
import type { StepEvent, StepPhase } from './stepSource'

export type RunStepEvent = Extract<PlatformEvent, { type: 'run.step' }>

/** What hook and file activity is attributed to: a run and the step its harness is on. */
export interface Attributable {
  runId: string
  activity: ActivityReporter
  sessionLinked: boolean
  currentStep?: string
  currentPhase?: StepPhase
}

/** A harness not seen polling for this long has stopped working on the run (its turn ended). */
const STALE_POLL_MS = 20_000
/** Opened, but it never called sdlc_next_step (the prompt may still be waiting for Enter): open it again after this. */
const UNANSWERED_LAUNCH_MS = 120_000
/** Re-read the run now and then, in case a live event was missed (approvals, the run ending). */
const REFRESH_EVERY_MS = 120_000
const TERMINAL = new Set<StoryRunStatus>(['completed', 'failed', 'cancelled', 'expired'])

interface Slot extends Attributable {
  harness: Harness
  tier: HarnessTier
  source: RemoteStepSource
  endpoints: BridgeEndpoints
  prompt: string
  launchedAt?: number
  launching?: Promise<void>
  /** Files tier: polls the platform for the harness and writes its checkpoint file. */
  pump?: CheckpointPump
}

export interface OrchestratedRunDeps {
  bridge: LocalBridge
  client: () => PlatformClient | undefined
  /** This window's presence id. */
  clientId: () => string
  log: (m: string) => void
  /** A harness hook → the run's activity (the same handling as extension-driven runs). */
  onHook: (target: Attributable, engine: string, payload: unknown) => void
  /** Files changed while a step executes, for harnesses without hooks. */
  watchFiles: (target: Attributable) => vscode.Disposable
  /** The run is over (a harness was told done/stopped, or the platform reports it ended): finish the session. */
  onEnd: (runId: string, outcome: 'done' | 'stopped', reason?: string) => void
  /** Report what the run changed so far; returns the files changed since the last report (the step's files). */
  reportChanges?: (runId: string, stepId?: string, step?: CompletingStep) => Promise<string[] | undefined>
  /** The tokens a harness spent on a step since the last call (Claude Code's transcript), if known. */
  takeTokens?: (runId: string, stepId: string) => { tokensIn: number; tokensOut: number } | undefined
}

export interface OrchestratedRunInit {
  launch: RunLaunch
  files: SessionFiles
  sessionDir: string
  activity: ActivityReporter
  /** What every harness's protocol file says about the run (all but its tier and harness). */
  orchestration: Omit<OrchestratorInput, 'tier' | 'harness'>
  /** Skills per agent node, with where they were written. */
  skillsByNode: Record<string, SkillRef[]>
  /** Each catalog agent's instructions and the file they were written to, by slug. */
  agents: Record<string, { instructions: string; file?: string }>
  /** For messages: `PAY-2` or `PAY-2-T1 · Title`. */
  title: string
}

export class OrchestratedRun implements Attributable {
  readonly runId: string
  readonly projectKey: string
  readonly activity: ActivityReporter
  sessionLinked = false
  private readonly slots = new Map<string, Slot>()
  private readonly adding = new Map<string, Promise<Slot | undefined>>()
  private readonly seenSteps = new Set<string>()
  /** Which harness was handed each step (files-tier checkpoints are submitted through it). */
  private readonly stepOwner = new Map<string, Slot>()
  private readonly prompted = new Set<string>()
  private readonly warned = new Set<string>()
  private readonly disposables: vscode.Disposable[] = []
  private executing: Slot | undefined
  private checkpointsWatched = false
  private filesWatched = false
  private refreshing: Promise<void> | undefined
  private refreshAgain = false
  private lastApprovalCheck = 0
  private finished = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly deps: OrchestratedRunDeps,
    private readonly init: OrchestratedRunInit,
  ) {
    this.runId = init.launch.run.id
    this.projectKey = init.launch.projectKey
    this.activity = init.activity
    this.timer = setInterval(() => void this.refresh(), REFRESH_EVERY_MS)
  }

  /** How the run is named to the user: `PAY-2`, `PAY-2-T1 · Title` or `Quick fix: …`. */
  get title(): string {
    return this.init.title
  }

  /** For file attribution: the step being executed by a harness without hooks (hooks report their own files). */
  get currentStep(): string | undefined {
    return this.executing && !reportsFilesViaHooks(this.executing.harness, this.executing.tier) ? this.executing.currentStep : undefined
  }

  get currentPhase(): StepPhase | undefined {
    return this.executing && !reportsFilesViaHooks(this.executing.harness, this.executing.tier) ? this.executing.currentPhase : undefined
  }

  // ─── Harnesses ────────────────────────────────────────────────────────────────────────────────

  /** Host a harness for this run: its SDLC tools (proxied to the platform), wiring and protocol file. Idempotent. */
  async host(harness: Harness): Promise<void> {
    await this.addSlot(harness)
  }

  private addSlot(harness: Harness): Promise<Slot | undefined> {
    const existing = this.slots.get(harness.id)
    if (existing) return Promise.resolve(existing)
    const inflight = this.adding.get(harness.id)
    if (inflight) return inflight
    const p = this.prepareSlot(harness).finally(() => this.adding.delete(harness.id))
    this.adding.set(harness.id, p)
    return p
  }

  private async prepareSlot(harness: Harness): Promise<Slot | undefined> {
    const { launch: l, sessionDir, files } = this.init
    const source = new RemoteStepSource({
      client: () => this.deps.client(),
      projectKey: this.projectKey,
      harness: harness.id,
      clientId: this.deps.clientId(),
      enrich: (a) => this.enrich(a),
      beforeComplete: (_runId, stepId, step) => this.deps.reportChanges?.(this.runId, stepId, step) ?? Promise.resolve(undefined),
      takeTokens: (_runId, stepId) => this.deps.takeTokens?.(this.runId, stepId),
    })
    // Filled in below; the tools and hooks look it up when called.
    let slot: Slot | undefined
    const endpoints = this.deps.bridge.open({
      runId: this.runId,
      engine: harness.id,
      tools: buildSdlcTools({
        runId: this.runId,
        projectKey: this.projectKey,
        storyNumber: l.storyNumber,
        prompt: l.prompt,
        sessionDir,
        steps: source,
        client: () => this.deps.client(),
        files,
        activity: () => this.activity,
        currentStep: () => slot?.currentStep,
      }),
      onHook: (engine, payload) => slot && this.deps.onHook(slot, engine, payload),
    })
    try {
      slot = await this.wire(harness, source, endpoints)
    } catch (err) {
      this.deps.bridge.close(endpoints.token)
      throw err
    }
    if (!slot) this.deps.bridge.close(endpoints.token)
    return slot
  }

  /** Write the harness's wiring and protocol file, then start hosting it. */
  private async wire(harness: Harness, source: RemoteStepSource, endpoints: BridgeEndpoints): Promise<Slot | undefined> {
    const { files, sessionDir } = this.init
    // Connect the harness to its tools (and hooks). A tracked config file means file checkpoints instead.
    let tier: HarnessTier = harness.tier
    const wiring = wiringFor(harness, { mcpUrl: endpoints.mcpUrl, hookUrl: endpoints.hookUrl(harness.id) })
    for (const w of wiring) {
      if (!(await files.applyWiring(w))) {
        tier = 'files'
        this.deps.log(`${w.path} is tracked by the repository (or unreadable), so ${harness.label} uses file checkpoints for this run.`)
      }
    }
    if (wiring.length === 0) tier = 'files'

    const who = { id: harness.id, label: harness.label }
    await files.writeText(protocolFile({ sessionDir, harness: who }), orchestratorMarkdown({ ...this.init.orchestration, tier, harness: who }))
    if (tier === 'files') await files.writeText(nextFile({ sessionDir, harness: who }), 'Waiting for your first step… read this file again in a few seconds.\n')
    const skillsDir = skillsDirFor(harness)
    await files.excludeFromGit(['.sdlc/', ...wiring.map((w) => w.path), ...(skillsDir ? [`${skillsDir}/sdlc-*/`] : [])])

    if (this.finished) return undefined
    const s: Slot = {
      runId: this.runId,
      activity: this.activity,
      sessionLinked: false,
      harness,
      tier,
      source,
      endpoints,
      prompt: launchPrompt({ ...this.init.orchestration, tier, harness: who }),
    }
    source.onEvent((e) => this.onStepEvent(s, e))
    source.onResult((_runId, next) => this.onPollResult(next))
    if (tier === 'files') {
      s.pump = new CheckpointPump({
        runId: this.runId,
        source,
        sessionDir,
        write: (text) => files.writeText(nextFile({ sessionDir, harness: who }), text),
        log: this.deps.log,
      })
      this.watchCheckpoints()
    }
    if (!reportsFilesViaHooks(harness, tier) && !this.filesWatched) {
      this.filesWatched = true
      this.disposables.push(this.deps.watchFiles(this))
    }
    this.slots.set(harness.id, s)
    this.activity.add({
      type: 'session.started',
      summary: `${harness.label}${harness.version ? ` ${harness.version}` : ''} · ${tier} detail`,
      data: { tier, harness: harness.id },
    })
    return s
  }

  /** The slot for a harness, hosting it now if it is installed but was not expected when the run started. */
  private async slotFor(harnessId: string): Promise<Slot | undefined> {
    const existing = this.slots.get(harnessId)
    if (existing) return existing
    const harness = findHarness(harnessId)
    if (!harness) {
      if (!this.warned.has(harnessId)) {
        this.warned.add(harnessId)
        void vscode.window.showWarningMessage(
          `${this.init.title}: the next step runs in ${harnessLabel(harnessId)}, which is not installed in this VS Code window. Install it, or change the step's harness in the workflow.`,
        )
      }
      return undefined
    }
    try {
      return await this.addSlot(harness)
    } catch (err) {
      this.deps.log(`Could not prepare ${harness.label} for run ${this.runId}: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /** Fill in what only this window knows: where the step's skills and its agent's instructions were written. */
  private enrich(a: StepAssignment): StepAssignment {
    const local = this.init.skillsByNode[a.nodeId] ?? []
    const byslug = new Map(local.map((s) => [s.slug, s]))
    const skills = a.skills.length ? a.skills.map((s) => (s.path ? s : { ...s, path: byslug.get(s.slug)?.path })) : local
    const agent = this.init.agents[a.agentId]
    return { ...a, skills, agentFile: a.agentFile ?? agent?.file, agentInstructions: a.agentInstructions ?? agent?.instructions }
  }

  // ─── Opening harnesses lazily ─────────────────────────────────────────────────────────────────

  /** An agent step is waiting for a harness: open that harness unless it is already working on the run. */
  async onStep(e: Pick<RunStepEvent, 'harness' | 'stepId' | 'phase'>): Promise<void> {
    if (this.finished) return
    const slot = await this.slotFor(e.harness)
    if (!slot || this.finished) return
    if (slot.pump) {
      // Files tier: this window polls for the harness. Open it the first time, and again after its turn ended.
      const resumed = !slot.pump.running && slot.source.idle
      slot.pump.start()
      if (slot.launchedAt === undefined || resumed) await this.open(slot)
      return
    }
    if (this.needsLaunch(slot, Date.now())) await this.open(slot)
  }

  private needsLaunch(slot: Slot, now: number): boolean {
    if (slot.launching) return false
    if (slot.launchedAt === undefined) return true
    const src = slot.source
    if (src.polling) return false
    const last = src.lastPollAt
    // Opened, but it has not asked for a step since: give the user time to press Enter (or paste the prompt).
    if (last === undefined || last < slot.launchedAt) return now - slot.launchedAt > UNANSWERED_LAUNCH_MS
    // It was told another harness has the next step (or the run ended): its turn is over.
    if (src.idle) return true
    return now - last > STALE_POLL_MS
  }

  private open(slot: Slot): Promise<void> {
    if (slot.launching) return slot.launching
    const again = slot.launchedAt !== undefined
    slot.launching = (async () => {
      const opened = await launch(slot.harness, slot.prompt)
      slot.launchedAt = Date.now()
      this.activity.add({
        type: 'harness.opened',
        summary: `${slot.harness.label}: ${opened.submitted ? 'Prompt sent' : opened.copied ? 'Prompt copied to the clipboard' : 'Prompt prefilled'}`,
        data: { harness: slot.harness.id },
      })
      if (!opened.submitted) {
        const what = again ? 'continue the run' : 'start'
        void vscode.window.showInformationMessage(
          opened.copied
            ? `${this.init.title}: the run prompt is on your clipboard — paste it into ${slot.harness.label} to ${what}.`
            : `${this.init.title}: ${slot.harness.label} is open with the run prompt — press Enter to ${what}.`,
        )
      }
    })()
      .catch((err: unknown) => this.deps.log(`Could not open ${slot.harness.label} for run ${this.runId}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        slot.launching = undefined
      })
    return slot.launching
  }

  // ─── What the harnesses do ────────────────────────────────────────────────────────────────────

  /** The same activity the local step channel produces, so the run's log reads the same. */
  private onStepEvent(slot: Slot, e: StepEvent): void {
    if (this.finished) return
    if (e.type === 'delivered') {
      slot.currentStep = e.stepId
      slot.currentPhase = e.phase
      this.stepOwner.set(e.stepId, slot)
      if (e.phase === 'execute') this.executing = slot
      if (!this.seenSteps.has(e.stepId)) {
        this.seenSteps.add(e.stepId)
        this.activity.add({ type: 'step.started', stepId: e.stepId, agentName: e.agentName, summary: e.agentName, data: { harness: slot.harness.id } })
      }
      if (e.phase === 'execute') {
        this.activity.add({ type: 'agent.started', stepId: e.stepId, agentName: e.agentName, agentType: e.agentId, summary: 'Executing the approved plan' })
      }
    } else if (e.type === 'plan.submitted') {
      this.activity.add({ type: 'plan.submitted', stepId: e.stepId, summary: e.plan })
    } else {
      for (const slug of e.skillsUsed) {
        harnessRuns.addSkill(e.runId, e.stepId, slug, 'declared')
        this.activity.add({ type: 'skill.used', stepId: e.stepId, skill: slug, data: { evidence: 'declared' } })
      }
      this.activity.add({ type: 'step.completed', stepId: e.stepId, summary: e.summary })
      slot.currentPhase = undefined
    }
  }

  private onPollResult(next: NextStep): void {
    if (this.finished) return
    if (next.action === 'done' || next.action === 'stopped') {
      this.deps.onEnd(this.runId, next.action, next.reason)
    } else if (next.action === 'waiting' && next.reason === 'approval' && Date.now() - this.lastApprovalCheck > STALE_POLL_MS) {
      // In case the run's change event was missed: see whether there is a decision to offer here.
      this.lastApprovalCheck = Date.now()
      void this.refresh()
    }
  }

  // ─── File checkpoints (harnesses without the SDLC tools) ──────────────────────────────────────

  private watchCheckpoints(): void {
    if (this.checkpointsWatched) return
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return
    this.checkpointsWatched = true
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${this.init.sessionDir}/*/{plan,done}.md`))
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const submitted = new Set<string>()
    // The harness may write the file in several goes: submit once it has settled.
    const onFile = (uri: vscode.Uri) => {
      const key = uri.toString()
      clearTimeout(timers.get(key))
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          void this.onCheckpoint(uri, submitted)
        }, 1_500),
      )
    }
    watcher.onDidCreate(onFile)
    watcher.onDidChange(onFile)
    this.disposables.push(watcher, { dispose: () => timers.forEach((t) => clearTimeout(t)) })
  }

  private async onCheckpoint(uri: vscode.Uri, submitted: Set<string>): Promise<void> {
    if (this.finished) return
    const parts = uri.path.split('/')
    const kind = parts.at(-1) === 'plan.md' ? 'plan' : 'done'
    const stepId = parts.at(-2) ?? ''
    const key = `${stepId}:${kind}`
    if (submitted.has(key)) return
    const slot = this.stepOwner.get(stepId) ?? [...this.slots.values()].find((s) => s.pump)
    if (!slot) return
    let text: string
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).trim()
    } catch {
      return
    }
    if (!text) return
    try {
      if (kind === 'plan') await slot.source.submitPlan(this.runId, stepId, text.slice(0, 4_000))
      else await slot.source.complete(this.runId, stepId, text.slice(0, 8_000), parseDone(text))
      submitted.add(key)
      slot.pump?.kick()
    } catch (err) {
      this.deps.log(`Run ${this.runId}: could not submit ${stepId}/${kind}.md: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ─── The run's state: approvals, and the run ending ───────────────────────────────────────────

  /** Re-read the run: offer a pending approval here, or finish if the platform says the run is over. */
  refresh(): Promise<void> {
    if (this.finished) return Promise.resolve()
    if (this.refreshing) {
      this.refreshAgain = true
      return this.refreshing
    }
    this.refreshing = this.readRun().finally(() => {
      this.refreshing = undefined
      if (this.refreshAgain) {
        this.refreshAgain = false
        void this.refresh()
      }
    })
    return this.refreshing
  }

  private async readRun(): Promise<void> {
    const client = this.deps.client()
    if (!client) return
    let run: ProjectRunDetail
    try {
      run = await client.projectRun(this.projectKey, this.runId)
    } catch (err) {
      this.deps.log(`Could not read run ${this.runId}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (this.finished) return
    if (TERMINAL.has(run.status)) {
      this.deps.onEnd(this.runId, run.status === 'completed' ? 'done' : 'stopped', run.error ?? `The run is ${RUN_STATUS_LABELS[run.status].toLowerCase()}.`)
      return
    }
    const pending = run.pendingApproval
    if (run.status === 'awaiting_approval' && pending && !this.prompted.has(pending.stepId)) {
      this.prompted.add(pending.stepId)
      void this.promptApproval(run, pending)
    }
  }

  private async promptApproval(run: ProjectRunDetail, pending: PendingApproval): Promise<void> {
    const step = run.steps.find((s) => s.stepId === pending.stepId)
    // What is being approved: the plan up for approval, or (approval nodes) the latest agent's output.
    const plan = pending.context ?? step?.plan ?? undefined
    const isOutput = pending.kind === 'approval'
    const view = isOutput ? 'View output' : 'View plan'
    const heading = isOutput ? `${pending.agentName ?? 'Previous step'} — output` : `Plan — ${pending.agentName ?? step?.label ?? pending.stepId}`
    for (;;) {
      const actions = plan ? ['Approve', 'Reject', view] : ['Approve', 'Reject']
      const pick = await vscode.window.showInformationMessage(`${this.init.title}: ${pending.question}`, ...actions)
      if (this.finished) return
      if (pick === view && plan) {
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# ${heading}\n\n${plan}\n` })
        await vscode.window.showTextDocument(doc, { preview: true })
        continue
      }
      if (pick === 'Reject') {
        const comment = await vscode.window.showInputBox({
          title: `Reject — ${this.init.title}`,
          prompt: 'Why? (optional — recorded on the run)',
          placeHolder: 'What should change',
          ignoreFocusOut: true,
        })
        if (comment === undefined) continue // Escape: back to the choice
        await this.decide(false, pending.stepId, comment.trim() || undefined)
        return
      }
      if (pick === 'Approve') await this.decide(true, pending.stepId)
      return // dismissed: decide on the web, or in the Runs view
    }
  }

  private async decide(approve: boolean, stepId: string, comment?: string): Promise<void> {
    const client = this.deps.client()
    if (!client) {
      void vscode.window.showWarningMessage('Not connected to the SDLC platform — decide on the web instead.')
      this.prompted.delete(stepId)
      return
    }
    try {
      await client.approveRun(this.projectKey, this.runId, { approve, stepId, ...(comment ? { comment } : {}) })
      vscode.window.setStatusBarMessage(approve ? `$(check) Approved — ${this.init.title} continues` : `$(x) Rejected — ${this.init.title} stops`, 5_000)
    } catch (err) {
      this.prompted.delete(stepId)
      void vscode.window.showErrorMessage(`Could not ${approve ? 'approve' : 'reject'} ${this.init.title}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ─── Ending ───────────────────────────────────────────────────────────────────────────────────

  async finish(outcome: 'done' | 'stopped', reason?: string): Promise<void> {
    if (this.finished) return
    this.finished = true
    clearInterval(this.timer)
    const slots = [...this.slots.values()]
    for (const s of slots) s.pump?.stop()
    // Let each harness's last poll reach the platform (it answers done/stopped) before the tools go away.
    setTimeout(() => {
      for (const s of slots) this.deps.bridge.close(s.endpoints.token)
    }, 60_000)
    for (const d of this.disposables) d.dispose()
    const text = `The run is **${outcome === 'done' ? 'done' : 'stopped'}**. ${reason ?? ''}\n`
    for (const s of slots) {
      if (s.tier === 'files') {
        await this.init.files.writeText(nextFile({ sessionDir: this.init.sessionDir, harness: { id: s.harness.id } }), text).catch(() => undefined)
      }
    }
    await this.activity.close()
  }

  /**
   * Take this run's MCP server and hooks out of each harness's config again (call once no other run in this window
   * still uses them): a harness session opened later would otherwise keep calling a bridge that is gone.
   */
  async unwire(): Promise<void> {
    for (const s of this.slots.values()) {
      for (const w of wiringFor(s.harness, { mcpUrl: '', hookUrl: '' })) {
        await this.init.files.removeWiring(w).catch((err: unknown) => this.deps.log(`Could not clean up ${w.path}: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
  }

  dispose(): void {
    this.finished = true
    clearInterval(this.timer)
    for (const s of this.slots.values()) {
      s.pump?.stop()
      this.deps.bridge.close(s.endpoints.token)
    }
    for (const d of this.disposables) d.dispose()
  }
}
