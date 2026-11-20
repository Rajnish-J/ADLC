// Runs a story's (or task's) workflow in the harness the user chose — started from the web (a `run.requested`
// event or a vscode:// link) or from VS Code itself. For each run it claims the run, checks out the story branch,
// writes the session files and the harness's MCP/hook config (git-ignored), binds the run to the external
// dispatcher, starts the workflow runtime, and opens the harness with the session prompt. While the run lasts it
// serves the SDLC tools on the local bridge and reports the harness's activity; when it ends, it cleans up.
//
// Orchestrator-driven runs (`RunLaunch.driver === 'orchestrator'`) are different: the platform's orchestrator runs
// the workflow and hands each agent step to the harness pinned to it, so this window never starts the runtime. It
// prepares the session for every harness the run needs and hosts them (OrchestratedRun): SDLC tools proxied to the
// platform, opened lazily when a `run.step` event says a step is waiting for a harness that is not polling.

import * as vscode from 'vscode'
import {
  harnessLabel,
  taskKey,
  type ActiveRun,
  type AgentDetail,
  type HarnessTier,
  type PlatformEvent,
  type RunLaunch,
  type Story,
  type WaitingStep,
} from '@sdlc/contracts'
import { PlatformError, type PlatformClient } from '../platformClient'
import { OrchestratedRun, type Attributable, type RunStepEvent } from './orchestratedRun'
import { getGitApi, getOriginRemote, getRepository, waitForRepository } from '../../integrations/git/gitRepository'
import type { ExternalEngineDispatcher } from '../../runtime/dispatch/external/externalEngineDispatcher'
import type { SkillRef } from '../../runtime/dispatch/external/stepChannel'
import type { RunState, WorkflowSpec } from '../../runtime/port'
import type { RunService } from '../../runtime/runService'
import { LocalBridge, type BridgeEndpoints } from '../bridge/localBridge'
import { normalizeHook, relativePath } from '../bridge/hookNormalizer'
import { findHarness, launch, reportsFilesViaHooks, skillsDirFor, wiringFor, type Harness } from '../engines/registry'
import { launchPrompt, orchestratorMarkdown, promptSummary } from '../engines/orchestratorPrompt'
import { registerPlatformAgents } from '../platformAgentRegistry'
import type { PlatformHandle } from '../platformHandle'
import { quickBranchName, sameRepository, storyBranchName, storyTaskPrompt } from '../storyFormat'
import { GitCli } from '../work/gitCli'
import { DEFAULT_DIFF_EXCLUDE, makeExcluder } from '../work/gitParse'
import { RunChangeTracker, type RunRepo } from '../work/runChanges'
import { commitStep } from '../work/runCommit'
import { TranscriptUsage } from '../bridge/transcriptUsage'
import type { CompletingStep } from './remoteSteps'
import { ActivityReporter } from './activityReporter'
import { harnessRuns } from './harnessRunInfo'
import { SessionFiles } from './sessionFiles'
import { buildSdlcTools, runMemoryMarkdown } from './sdlcTools'
import { MEMORY_OUT_DIR, memoryOutboxHint, parseMemoryNote } from './memoryOutbox'

const CONSENT_KEY = 'sdlcGovernance.harnessConsent'
const TERMINAL = new Set<RunState['status']>(['completed', 'failed', 'cancelled'])

/** `resume`: a `run.step` for a run this window claimed before (e.g. before a reload) — pick it up again quietly. */
export type RequestSource = 'sse' | 'uri' | 'catchup' | 'local' | 'resume'

/** At most this many `run.step` events are kept per run while it is being prepared. */
const MAX_BUFFERED_STEPS = 20
/** Focus changes often; ask for pending runs at most this often. */
const CATCH_UP_EVERY_MS = 5_000
/** A note in the memory outbox is saved once it has not changed for this long (the agent may still be writing it). */
const OUTBOX_SETTLE_MS = 2_000
/** A harness's transcript is read for token usage at most this often while it works (and always when it stops). */
const USAGE_READ_EVERY_MS = 5_000
/** Run statuses after which a queued run is not started. */
const ENDED = new Set(['completed', 'failed', 'cancelled', 'expired'])

interface Outbox {
  flush: (stepId?: string) => Promise<void>
  dispose: () => void
}

// ─── What a launch works on: a story, one of its tasks, or a quick fix (a prompt, no story) ──────

/** How the run is named to the user: `PAY-2-T1 · Title`, `PAY-2`, or `Quick fix: <prompt>`. */
export function launchLabel(l: Pick<RunLaunch, 'task' | 'storyKey' | 'prompt'>): string {
  if (l.task) return `${l.task.key} · ${l.task.title}`
  return l.storyKey ?? `Quick fix: ${promptSummary(l.prompt ?? '', 60) || 'no description'}`
}

/** The run's session folder under `.sdlc/sessions/`: the task or story key, or `run-<id>` for a quick fix. */
export function launchSessionDir(l: Pick<RunLaunch, 'task' | 'storyKey' | 'run'>): string {
  if (!l.storyKey) return `.sdlc/sessions/run-${l.run.id.slice(0, 8)}`
  return `.sdlc/sessions/${l.task ? `${l.storyKey}-T${l.task.number}` : l.storyKey}`
}

/** The part of the orchestrator instructions that says what the run works on. */
function launchTarget(l: RunLaunch, story: Story | null) {
  return {
    storyKey: l.storyKey,
    storyTitle: story?.title ?? null,
    taskKey: l.task && l.storyKey ? taskKey(l.storyKey, l.task.number) : null,
    taskTitle: l.task?.title ?? null,
    quickFix: l.storyKey ? null : promptSummary(l.prompt ?? ''),
  }
}

/** The workspace's repository as the change tracker sees it (waits briefly for the git extension to open it). */
async function runRepo(): Promise<RunRepo | undefined> {
  const repo = await waitForRepository()
  const gitPath = (await getGitApi())?.git.path
  if (!repo || !gitPath) return undefined
  const root = repo.rootUri.fsPath
  return { git: new GitCli(gitPath, root), root, branch: () => repo.state.HEAD?.name ?? null }
}

interface Active {
  runId: string
  projectKey: string
  harness: Harness
  tier: HarnessTier
  endpoints: BridgeEndpoints
  activity: ActivityReporter
  files: SessionFiles
  sessionDir: string
  /** The step the harness is working on (last delivered), for attributing hook events. */
  currentStep?: string
  currentPhase?: 'plan' | 'execute'
  seenSteps: Set<string>
  disposables: vscode.Disposable[]
  sessionLinked: boolean
  /** How the run is named to the user (the "finished" notification). */
  title: string
}

export interface HarnessSessionDeps {
  context: vscode.ExtensionContext
  platform: PlatformHandle
  runs: RunService
  external: ExternalEngineDispatcher
  /** This window's presence id (the same one the web targets). */
  clientId: () => string
  log: (m: string) => void
}

export class HarnessSessions implements vscode.Disposable {
  private readonly bridge: LocalBridge
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly active = new Map<string, Active>()
  /** Orchestrator-driven runs hosted here. */
  private readonly orchestrated = new Map<string, OrchestratedRun>()
  /** `run.step` events that arrived while their run was still being claimed and prepared. */
  private readonly stepBuffer = new Map<string, RunStepEvent[]>()
  /** Orchestrator-driven runs that could not start here: never resumed automatically. */
  private readonly failedRuns = new Set<string>()
  /** Each project's repository URL (null: none linked), fetched once per session for matching this window. */
  private readonly projectRepos = new Map<string, string | null>()
  private lastCatchUp = 0
  /** Each hosted run's memory outbox. */
  private readonly outboxes = new Map<string, Outbox>()
  private readonly subscriptions: vscode.Disposable[] = []
  /** What each run changed against the commit it started from, reported to the run's page. */
  private readonly runChanges: RunChangeTracker
  /**
   * Orchestrator-driven runs claimed while another run was being hosted here: one run per workspace (they would
   * share its working tree, branch and harness config), so they wait and start in order.
   */
  private readonly queued: RunLaunch[] = []
  /** Runs being prepared (between the claim and being hosted) — counted as busy, so a second one queues. */
  private readonly starting = new Set<string>()
  /** The branch each hosted run works on: each step's files are committed there. */
  private readonly runBranches = new Map<string, string>()
  /** Token usage read from each run's harness transcripts (Claude Code). */
  private readonly usage = new Map<string, { reader: TranscriptUsage; readAt: number }>()

  constructor(private readonly deps: HarnessSessionDeps) {
    this.bridge = new LocalBridge(String((deps.context.extension.packageJSON as { version?: string }).version ?? '0.0.0'))
    this.runChanges = new RunChangeTracker({
      client: () => deps.platform.client(),
      store: deps.context.workspaceState,
      settings: () => {
        const cfg = vscode.workspace.getConfiguration('sdlcGovernance')
        return { shareDiffs: cfg.get<boolean>('platform.shareDiffs', true), exclude: makeExcluder(cfg.get<string[]>('platform.diffExclude', DEFAULT_DIFF_EXCLUDE)) }
      },
      log: deps.log,
      resolveRepo: runRepo,
    })
    this.subscriptions.push(
      deps.platform.onEvent((e) => this.onPlatformEvent(e)),
      deps.runs.onDidChangeRun((s) => this.onRun(s)),
      deps.runs.onDidDecide((d) => {
        const a = this.active.get(d.runId)
        if (!a) return
        a.activity.add({ type: 'approval.decided', stepId: d.stepId, summary: `${d.approve ? 'Approved' : 'Rejected'} by ${d.actor}${d.comment ? `: ${d.comment}` : ''}` })
        if (d.approve && a.harness.id !== 'copilot') {
          void vscode.window.showInformationMessage(
            `Plan approved. ${a.harness.label} continues when it next calls sdlc_next_step — if it has stopped, tell it “continue”.`,
          )
        }
      }),
      deps.external.onEvent((e) => this.onChannelEvent(e)),
      vscode.window.registerUriHandler({ handleUri: (uri) => this.onUri(uri) }),
      // A run sent to no window in particular waits for the window the user looks at: check when this one gets focus.
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) void this.catchUp()
      }),
    )
  }

  // ─── Where requests come from ─────────────────────────────────────────────────────────────────

  private onPlatformEvent(e: PlatformEvent): void {
    if (e.type === 'run.requested') {
      if (e.clientId && e.clientId !== this.deps.clientId()) return
      // Untargeted: the window the user is looking at takes it (the deep link lands there too) — or, unfocused, a
      // window that has the project's repository open (it connected after the run was requested).
      if (!e.clientId && !vscode.window.state.focused) {
        void this.repoMatch(e.projectKey).then((m) => {
          if (m.matches) void this.handle(e.runId, 'sse')
        })
        return
      }
      void this.handle(e.runId, 'sse')
    } else if (e.type === 'run.command') {
      if (e.command === 'cancel' && this.active.has(e.runId)) {
        void this.deps.runs.cancel(e.runId).catch((err) => this.deps.log(`Could not cancel ${e.runId}: ${String(err)}`))
      } else if (e.command === 'cancel' && this.dropQueued(e.runId)) {
        this.deps.log(`Run ${e.runId} was cancelled while queued.`)
      } else if (e.command === 'cancel' && this.orchestrated.has(e.runId)) {
        // The platform drives it and has stopped it: the harnesses' next poll says so; end the session here.
        void this.finishOrchestrated(e.runId, 'stopped', 'The run was cancelled.')
      }
    } else if (e.type === 'run.step') {
      this.onRunStep(e)
    } else if (e.type === 'work.changed') {
      // An orchestrator-driven run changed on the platform: an approval to offer here, or the run ended.
      if (e.kind === 'run' && e.runId) void this.orchestrated.get(e.runId)?.refresh()
    } else if (e.type === 'ready') {
      void this.catchUp(true)
      for (const run of this.orchestrated.values()) void run.refresh()
    }
  }

  /** An agent step of an orchestrator-driven run is waiting for a harness. */
  private onRunStep(e: RunStepEvent): void {
    // Queued behind another run: it is started (with its waiting steps) when that run ends.
    if (this.queued.some((q) => q.run.id === e.runId)) return
    const run = this.orchestrated.get(e.runId)
    if (run) {
      void run.onStep(e).catch((err: unknown) => this.deps.log(`Run ${e.runId}: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    if (this.inflight.has(e.runId)) {
      this.bufferStep(e)
      return
    }
    // Claimed by this window before (e.g. before VS Code reloaded): pick it up again, then open the harness.
    if (e.clientId !== this.deps.clientId() || this.failedRuns.has(e.runId) || this.active.has(e.runId)) return
    this.bufferStep(e)
    void this.handle(e.runId, 'resume')
  }

  private bufferStep(e: RunStepEvent): void {
    const list = (this.stepBuffer.get(e.runId) ?? []).filter((x) => !(x.stepId === e.stepId && x.phase === e.phase && x.harness === e.harness))
    list.push(e)
    this.stepBuffer.set(e.runId, list.slice(-MAX_BUFFERED_STEPS))
  }

  private onUri(uri: vscode.Uri): void {
    const params = new URLSearchParams(uri.query)
    const runId = params.get('run')
    if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) return
    if (uri.path === '/start') void this.handle(runId, 'uri', params.get('project') ?? undefined)
    else if (uri.path === '/open') void this.openRun(params.get('project') ?? '', runId)
  }

  /** From a run's page on the web: check out the branch the run worked on and show its changes. */
  private async openRun(projectKey: string, runId: string): Promise<void> {
    const client = this.deps.platform.client()
    if (!client || !/^[A-Za-z][A-Za-z0-9]{0,19}$/.test(projectKey)) {
      void vscode.window.showWarningMessage('Connect VS Code to the SDLC platform first, then open the run again.')
      return
    }
    try {
      const run = await client.projectRun(projectKey, runId)
      const branch = run.changes?.branch ?? run.branch
      if (!branch) {
        void vscode.window.showInformationMessage('VS Code has not reported a branch for this run yet.')
        return
      }
      const repo = await getRepository()
      if (!repo) throw new Error('Open the project repository folder in this window first.')
      if (repo.state.HEAD?.name !== branch) {
        const ok = await vscode.window.showInformationMessage(`Check out ${branch} to review this run's changes?`, { modal: true }, 'Check out')
        if (ok !== 'Check out') return
        await repo.checkout(branch)
      }
      await vscode.commands.executeCommand('workbench.view.scm')
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not open the run: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Remember the commit a run starts from, so its page can show what it changed. Never blocks the run. */
  private async beginRunChanges(runId: string): Promise<void> {
    try {
      const repo = await runRepo()
      if (!repo) {
        this.deps.log(`Run ${runId}: no git repository is open in this window, so its file changes are not tracked.`)
        void vscode.window.showWarningMessage('No git repository is open in this window: the run’s file changes will not be shown on the platform.')
        return
      }
      await this.runChanges.begin(runId, repo)
    } catch (err) {
      this.deps.log(`Could not record where run ${runId} starts: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** After a run ends: report its final changes, and offer its page on the web. */
  private async endRunChanges(projectKey: string, runId: string, title: string, outcome: 'done' | 'stopped'): Promise<void> {
    await this.runChanges.end(projectKey, runId)
    const webUrl = vscode.workspace.getConfiguration('sdlcGovernance.platform').get<string>('webUrl', 'http://localhost:3000').trim().replace(/[/]+$/, '')
    const url = `${webUrl}/projects/${encodeURIComponent(projectKey)}/workflow/runs/${encodeURIComponent(runId)}`
    const pick = await vscode.window.showInformationMessage(`${title} ${outcome === 'done' ? 'finished' : 'stopped'}.`, 'View run')
    if (pick === 'View run') void vscode.env.openExternal(vscode.Uri.parse(url))
  }

  /**
   * After (re)connecting, or when this window gets focus: runs sent to this window while it was offline, and runs
   * sent to no window in particular (several fit) when this is the window the user is looking at. Without this an
   * untargeted request whose browser "Open VS Code?" prompt was dismissed would expire unnoticed.
   */
  private async catchUp(force = false): Promise<void> {
    const client = this.deps.platform.client()
    if (!client) return
    const now = Date.now()
    if (!force && now - this.lastCatchUp < CATCH_UP_EVERY_MS) return
    this.lastCatchUp = now
    try {
      const pending = await client.pendingRuns()
      const focused = vscode.window.state.focused
      for (const p of pending) {
        if (p.clientId === this.deps.clientId() || (!p.clientId && focused)) void this.handle(p.runId, 'catchup')
        else if (!p.clientId && (await this.repoMatch(p.projectKey)).matches) void this.handle(p.runId, 'catchup')
      }
    } catch {
      /* older API or offline — the deep link still works */
    }
    await this.resumeOrphans()
  }

  /**
   * Runs this window claimed before a reload whose harness already had a step: the platform re-announces only steps
   * nobody picked up, so without this such a run would sit until its time budget ran out. Re-host them and re-open
   * the harness for the step it was working on.
   */
  private async resumeOrphans(): Promise<void> {
    const client = this.deps.platform.client()
    if (!client) return
    const runs = await client.activeRuns().catch(() => [])
    for (const r of runs) {
      if (r.driver !== 'orchestrator' || r.clientId !== this.deps.clientId() || r.status === 'requested') continue
      if (this.orchestrated.has(r.runId) || this.inflight.has(r.runId) || this.starting.has(r.runId)) continue
      if (this.failedRuns.has(r.runId) || this.queued.some((q) => q.run.id === r.runId)) continue
      for (const w of r.waitingSteps) this.bufferStep(waitingStepEvent(r, w))
      void this.handle(r.runId, 'resume')
    }
  }

  /** Remove a queued run (cancelled on the platform). True when it was queued. */
  private dropQueued(runId: string): boolean {
    const i = this.queued.findIndex((q) => q.run.id === runId)
    if (i < 0) return false
    this.queued.splice(i, 1)
    return true
  }

  /** Start a story or task from VS Code in a harness installed here (the Story panel / tree "Start in…"). */
  async startLocal(story: Story, workflowId: string, engine: string, taskNumber?: number | null): Promise<void> {
    const client = this.deps.platform.client()
    if (!client) {
      void vscode.window.showWarningMessage('Connect to the SDLC platform first (sdlcGovernance.platform.apiUrl).')
      return
    }
    try {
      const { run } = await client.requestRun(story.projectKey, {
        storyNumber: story.number,
        taskNumber: taskNumber ?? null,
        workflowId,
        engine,
        clientId: this.deps.clientId(),
      })
      await this.handle(run.id, 'local')
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not start ${story.key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Is this window on the project's repository? `matches` is null when that can't be told: no linked repo (a blank
   * project's DB workspace), or the platform is unreachable.
   */
  private async repoMatch(projectKey: string): Promise<{ matches: boolean | null; repoUrl: string | null; here: string | null }> {
    const here = vscode.workspace.workspaceFolders?.[0]?.name ?? null
    let repoUrl = this.projectRepos.get(projectKey)
    if (repoUrl === undefined) {
      const client = this.deps.platform.client()
      if (!client) return { matches: null, repoUrl: null, here }
      try {
        repoUrl = (await client.project(projectKey)).repoUrl
        this.projectRepos.set(projectKey, repoUrl)
      } catch {
        return { matches: null, repoUrl: null, here }
      }
    }
    if (!repoUrl) return { matches: null, repoUrl: null, here }
    const repo = await getRepository().catch(() => undefined)
    const origin = repo ? getOriginRemote(repo) : undefined
    return { matches: sameRepository(origin?.fetchUrl ?? origin?.pushUrl, repoUrl), repoUrl, here }
  }

  private handle(runId: string, source: RequestSource, projectKey?: string): Promise<void> {
    if (this.active.has(runId) || this.orchestrated.has(runId)) return Promise.resolve()
    const existing = this.inflight.get(runId)
    if (existing) return existing
    const p = this.claimAndStart(runId, source, projectKey).finally(() => {
      this.inflight.delete(runId)
      this.stepBuffer.delete(runId)
    })
    this.inflight.set(runId, p)
    return p
  }

  private async claimAndStart(runId: string, source: RequestSource, projectKey?: string): Promise<void> {
    const client = this.deps.platform.client()
    if (!client) {
      if (source === 'uri') void vscode.window.showWarningMessage('Connect this VS Code to the SDLC platform to start runs from the web.')
      return
    }
    // A vscode:// link lands in whichever window was focused last. Before taking the run here, make sure this window
    // is on the project's repository — otherwise leave the run for the window that is (or for a clone).
    let confirmed = false
    if (source === 'uri' && projectKey) {
      const m = await this.repoMatch(projectKey)
      if (m.matches === false) {
        const where = m.here ? `“${m.here}”` : 'no folder'
        const pick = await vscode.window.showWarningMessage(
          `This window has ${where} open, but ${projectKey}'s run works in ${m.repoUrl}.`,
          {
            modal: true,
            detail:
              'Open that repository in VS Code (or clone it) and the run starts there: a window with the repository picks it up by itself. Or start it in this folder anyway.',
          },
          'Clone repository',
          'Start here anyway',
        )
        if (pick === 'Clone repository' && m.repoUrl) void vscode.commands.executeCommand('git.clone', m.repoUrl)
        if (pick !== 'Start here anyway') return
        confirmed = true
      }
    }
    let launchInfo: RunLaunch
    try {
      launchInfo = await client.claimRun(runId, this.deps.clientId())
    } catch (err) {
      if (source !== 'catchup' && source !== 'resume') void vscode.window.showWarningMessage(`Could not start the run: ${err instanceof Error ? err.message : String(err)}`)
      // The platform refused it (not just unreachable): do not keep trying on every run.step.
      if (source === 'resume' && err instanceof PlatformError && err.status !== undefined) this.failedRuns.add(runId)
      return
    }
    const orchestrated = launchInfo.driver === 'orchestrator'
    // Only an orchestrator-driven run can be picked up again; an extension-driven one would start over.
    if (source === 'resume' && !orchestrated) return
    const what = launchLabel(launchInfo)
    const where = listOf(runHarnesses(launchInfo).map(harnessLabel))
    if (source === 'uri' && !confirmed) {
      // Any web page can open a vscode:// link, so a link alone never starts work without the user saying so.
      const go = await vscode.window.showInformationMessage(
        `Start ${what} in ${where}?`,
        { modal: true, detail: `Workflow run requested from the SDLC platform (${launchInfo.run.workflowName}).` },
        'Start',
      )
      if (go !== 'Start') {
        // Claiming already started it on the platform: stop it there, or it would resume here without asking.
        this.failedRuns.add(runId)
        await client.cancelRun(launchInfo.projectKey, runId, 'Declined in VS Code.').catch((err: unknown) => {
          this.deps.log(`Could not cancel declined run ${runId}: ${err instanceof Error ? err.message : String(err)}`)
        })
        return
      }
    } else if (source === 'resume') {
      vscode.window.setStatusBarMessage(`$(sync) Picking up ${what} again in ${where}`, 5_000)
    } else if (source !== 'local') {
      void vscode.window.showInformationMessage(`Starting ${what} in ${where} — requested from the web.`)
    }
    // One run per workspace: another one is being hosted (or prepared) here — this one waits its turn.
    if (orchestrated && this.busyWith(runId)) {
      await this.enqueue(launchInfo, what)
      return
    }
    await this.startClaimed(launchInfo, what)
  }

  /** The title of a run (other than `runId`) this window hosts or is preparing, if any. */
  private busyWith(runId: string): string | undefined {
    for (const [id, r] of this.orchestrated) if (id !== runId) return r.title
    for (const a of this.active.values()) if (a.runId !== runId) return a.title
    for (const id of this.starting) if (id !== runId) return 'another run'
    return undefined
  }

  private async startClaimed(l: RunLaunch, what: string): Promise<void> {
    const runId = l.run.id
    const orchestrated = l.driver === 'orchestrator'
    this.starting.add(runId)
    try {
      if (orchestrated) await this.startOrchestrated(l)
      else await this.start(l)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log(`Run ${runId} could not start: ${message}`)
      void vscode.window.showErrorMessage(`Could not start ${what}: ${message}`)
      if (orchestrated) this.failedRuns.add(runId)
      await this.reportFailed(l, message)
    } finally {
      this.starting.delete(runId)
    }
  }

  /** Hold a claimed run until the one this window hosts ends; say so here and on the run's page. */
  private async enqueue(l: RunLaunch, what: string): Promise<void> {
    if (this.queued.some((q) => q.run.id === l.run.id)) return
    const ahead = this.busyWith(l.run.id) ?? 'another run'
    this.queued.push(l)
    this.deps.log(`Run ${l.run.id} is queued behind ${ahead}.`)
    void vscode.window.showInformationMessage(`${what} is queued: it starts here when ${ahead} finishes (one run per workspace at a time).`)
    const activity = new ActivityReporter(l.projectKey, l.run.id, () => this.deps.platform.client(), this.deps.context.workspaceState, this.deps.log)
    activity.add({ type: 'nudge', summary: `Queued in VS Code behind ${ahead}`, data: { queued: true, behind: ahead, position: this.queued.length } })
    await activity.close()
  }

  /** The hosted run ended: start the next queued one that is still running on the platform. */
  private async startNextQueued(): Promise<void> {
    while (!this.busyWith('') && this.queued.length > 0) {
      const next = this.queued.shift()
      if (!next) return
      const client = this.deps.platform.client()
      if (!client) {
        this.queued.unshift(next)
        return
      }
      const status = await client
        .projectRun(next.projectKey, next.run.id)
        .then((r) => r.status as string)
        .catch(() => undefined)
      if (status && ENDED.has(status)) continue
      // Re-open the harness for whatever step the platform handed out while the run waited.
      const mine = (await client.activeRuns().catch(() => [])).find((r) => r.runId === next.run.id)
      if (mine) for (const w of mine.waitingSteps) this.bufferStep(waitingStepEvent(mine, w))
      const activity = new ActivityReporter(next.projectKey, next.run.id, () => this.deps.platform.client(), this.deps.context.workspaceState, this.deps.log)
      activity.add({ type: 'nudge', summary: 'Starting in VS Code (was queued)', data: { queued: false } })
      void activity.close()
      await this.startClaimed(next, launchLabel(next))
      return
    }
  }

  private async reportFailed(l: RunLaunch, error: string): Promise<void> {
    // An orchestrator-driven run's state is the platform's: never overwrite it with a local snapshot — stop it there
    // instead, with the reason, so it doesn't sit "running" until its time budget runs out.
    if (l.driver === 'orchestrator') {
      await this.deps.platform
        .client()
        ?.cancelRun(l.projectKey, l.run.id, `Could not start in VS Code: ${error}`)
        .catch((err: unknown) => this.deps.log(`Could not stop run ${l.run.id} on the platform: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    // Reported runs belong to a story; a quick fix is always platform-driven.
    if (l.storyNumber == null) return
    const now = new Date().toISOString()
    await this.deps.platform
      .client()
      ?.reportRun(l.projectKey, l.storyNumber, l.run.id, {
        workflowName: l.run.workflowName,
        status: 'failed',
        startedAt: now,
        finishedAt: now,
        error: error.slice(0, 4_000),
        engine: l.engine,
        taskNumber: l.task?.number ?? null,
        steps: [],
      })
      .catch(() => undefined)
  }

  // ─── Starting a run ───────────────────────────────────────────────────────────────────────────

  private async start(l: RunLaunch): Promise<void> {
    const client = this.deps.platform.client()
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!client) throw new Error('Not connected to the platform.')
    if (!folder) throw new Error('Open the story’s repository folder in this window first.')
    const harness = findHarness(l.engine)
    if (!harness) throw new Error(`${harnessLabel(l.engine)} is not installed in this VS Code window.`)

    const { story, workflow, agentNodes, details } = await this.loadRunContext(client, l)

    // The story branch (the same branch the story's other work is on), or a fresh branch for a quick fix.
    await this.prepareBranch(l, story)

    await this.ensureConsent(harness.label)
    // What the run changes, for its page on the platform — the same as orchestrator-driven runs.
    await this.beginRunChanges(l.run.id)

    const gitPath = (await getGitApi())?.git.path
    const files = new SessionFiles(folder.uri, gitPath)
    const sessionDir = launchSessionDir(l)
    const runId = l.run.id

    await this.bridge.start()
    const activity = new ActivityReporter(l.projectKey, runId, () => this.deps.platform.client(), this.deps.context.workspaceState, this.deps.log)
    const allowPath = negate(makeExcluder(vscode.workspace.getConfiguration('sdlcGovernance').get<string[]>('platform.diffExclude', DEFAULT_DIFF_EXCLUDE)))
    // Filled in below; the tools and hooks look it up when called.
    let active: Active | undefined
    const endpoints = this.bridge.open({
      runId,
      engine: harness.id,
      tools: buildSdlcTools({
        runId,
        projectKey: l.projectKey,
        storyNumber: l.storyNumber,
        prompt: l.prompt,
        sessionDir,
        steps: this.deps.external.channel,
        client: () => this.deps.platform.client(),
        files,
        activity: () => active?.activity,
        currentStep: () => active?.currentStep,
      }),
      onHook: (engine, payload) => active && this.onHook(active, engine, payload, allowPath),
    })

    // Session files: story, memory, agents, skills, the orchestrator protocol.
    const { memory, storyText, bySlug, agentFiles } = await this.writeContextFiles(client, l, story, details, files, sessionDir)
    const skillsDir = skillsDirFor(harness)
    const skillsByNode: Record<string, SkillRef[]> = {}
    for (const node of agentNodes) {
      const refs: SkillRef[] = []
      for (const slug of Array.isArray(node.data.skills) ? node.data.skills : []) {
        const skill = bySlug.get(slug)
        if (!skill) continue
        const file = skillsDir ? `${skillsDir}/sdlc-${slug}/SKILL.md` : `${sessionDir}/skills/${slug}.md`
        const body = skillsDir
          ? `---\nname: sdlc-${slug}\ndescription: ${JSON.stringify((skill.description ?? skill.name).slice(0, 300))}\n---\n\n${skill.instructions}\n`
          : `# Skill: ${skill.name}\n\n${skill.description ?? ''}\n\n${skill.instructions}\n`
        await files.writeText(file, body)
        refs.push({ slug, name: skill.name, path: file })
      }
      skillsByNode[node.id] = refs
    }

    // Connect the harness to this run's tools (and hooks). A tracked config file means file checkpoints instead.
    let tier: HarnessTier = harness.tier
    const wiring = wiringFor(harness, { mcpUrl: endpoints.mcpUrl, hookUrl: endpoints.hookUrl(harness.id) })
    for (const w of wiring) {
      const ok = await files.applyWiring(w)
      if (!ok) {
        tier = 'files'
        this.deps.log(`${w.path} is tracked by the repository (or unreadable), so ${harness.label} uses file checkpoints for this run.`)
      }
    }
    if (wiring.length === 0) tier = 'files'

    const steps = agentNodes.map((n) => ({
      label: n.label || n.id,
      agentName: typeof n.data.agentName === 'string' ? n.data.agentName : null,
      skills: (skillsByNode[n.id] ?? []).map((s) => s.slug),
    }))
    const orchestration = {
      runId,
      ...launchTarget(l, story),
      workflowName: workflow.name,
      steps,
      sessionDir,
      tier,
    }
    await files.writeText(`${sessionDir}/ORCHESTRATOR.md`, orchestratorMarkdown(orchestration))
    if (tier === 'files') await files.writeText(`${sessionDir}/next.md`, 'Waiting for the first step… read this file again in a few seconds.\n')
    await files.excludeFromGit(['.sdlc/', ...wiring.map((w) => w.path), ...(skillsDir ? [`${skillsDir}/sdlc-*/`] : [])])

    active = {
      runId,
      projectKey: l.projectKey,
      harness,
      tier,
      endpoints,
      activity,
      files,
      sessionDir,
      seenSteps: new Set(),
      disposables: [],
      sessionLinked: false,
      title: launchLabel(l),
    }
    this.active.set(runId, active)
    harnessRuns.set(runId, {
      engine: harness.id,
      engineModel: l.engineModel,
      engineSessionId: null,
      workflowId: l.workflowId,
      workflowVersion: workflow.version,
      taskNumber: l.task?.number ?? null,
    })
    this.deps.external.bindRun({ runId, engine: harness.id, engineModel: l.engineModel, skillsByNode, agents: agentFiles })
    if (tier === 'files') active.disposables.push(this.watchCheckpoints(active))
    if (!reportsFilesViaHooks(harness, tier)) active.disposables.push(this.watchFiles(active, folder, allowPath))
    activity.add({ type: 'session.started', summary: `${harness.label}${harness.version ? ` ${harness.version}` : ''} · ${tier} detail`, data: { tier } })

    // External runs wait on people and harnesses, so they get a much longer clock than in-process runs.
    const minutes = vscode.workspace.getConfiguration('sdlcGovernance').get<number>('platform.externalRunTimeoutMinutes', 240)
    const spec: WorkflowSpec = { ...workflow.spec, budget: { ...workflow.spec.budget, timeoutMs: Math.max(5, minutes) * 60_000, maxTokens: 0 } }
    const actor = this.deps.platform.me()?.user.email ?? 'local-user'
    let task = storyText
    if (memory) task += `\n\n## Project knowledge\n\n${memory}`
    // startRun resolves at the first pause (the harness's first plan), so it is not awaited here.
    void this.deps.runs
      .startRun(spec, actor, { task, storyKey: l.storyKey ?? launchLabel(l), taskNumber: l.task?.number, engine: harness.id }, { runId })
      .catch((err: unknown) => {
        this.deps.log(`Run ${runId} failed to start: ${String(err)}`)
        void this.finish(runId, 'stopped')
      })

    const opened = await launch(harness, launchPrompt(orchestration))
    activity.add({ type: 'harness.opened', summary: opened.submitted ? 'Prompt sent' : opened.copied ? 'Prompt copied to the clipboard' : 'Prompt prefilled' })
    if (!opened.submitted) {
      void vscode.window.showInformationMessage(
        opened.copied
          ? `The run prompt is on your clipboard — paste it into ${harness.label} to start.`
          : `${harness.label} is open with the run prompt — press Enter to start.`,
      )
    }
  }

  /**
   * The story (none for a quick fix), the workflow, and the catalog agents and skills its agent steps use (registered
   * for the views).
   */
  private async loadRunContext(client: PlatformClient, l: RunLaunch) {
    const story = l.storyNumber != null ? await client.story(l.projectKey, l.storyNumber) : null
    // The workflow exactly as the platform runs it (its snapshot), so an edit made since can't desync the steps.
    const workflow = l.workflowSpec
      ? { name: l.run.workflowName, version: l.workflowVersion, spec: l.workflowSpec as unknown as WorkflowSpec }
      : await client.workflow(l.projectKey, l.workflowId)
    const agentNodes = workflow.spec.nodes.filter((n) => n.kind === 'agent')
    const slugs = [
      ...new Set(
        agentNodes.flatMap((n) => [
          ...(typeof n.data.agentId === 'string' && n.data.agentId ? [n.data.agentId] : []),
          ...(Array.isArray(n.data.skills) ? n.data.skills : []),
        ]),
      ),
    ]
    const missing: string[] = []
    const details: AgentDetail[] = (
      await Promise.all(
        slugs.map((slug) =>
          client.agent(l.projectKey, slug).catch((err: unknown) => {
            missing.push(slug)
            this.deps.log(`Run ${l.run.id}: could not load agent/skill "${slug}": ${err instanceof Error ? err.message : String(err)}`)
            return undefined
          }),
        ),
      )
    ).filter((a): a is AgentDetail => !!a)
    registerPlatformAgents(details.filter((a) => a.kind === 'agent'))
    if (missing.length) {
      void vscode.window.showWarningMessage(`${launchLabel(l)}: could not load ${listOf(missing.map((m) => `"${m}"`))} — those steps run without them.`)
    }
    return { story, workflow, agentNodes, details, missing }
  }

  /** Once per workspace: may harnesses write their session files and settings here? */
  private async ensureConsent(harnesses: string): Promise<void> {
    if (this.deps.context.workspaceState.get<boolean>(CONSENT_KEY)) return
    const ok = await vscode.window.showInformationMessage(
      `Let ${harnesses} run SDLC workflows in this workspace?`,
      {
        modal: true,
        detail:
          'SDLC writes a session folder (.sdlc/) and the harness’s tool and hook settings (for example .mcp.json, .claude/settings.local.json, .vscode/mcp.json). ' +
          'They are listed in .git/info/exclude so they are never committed, and files your repository tracks are never changed.',
      },
      'Allow',
    )
    if (ok !== 'Allow') throw new Error('Not allowed to write the session files in this workspace.')
    await this.deps.context.workspaceState.update(CONSENT_KEY, true)
  }

  /**
   * Check out the run's branch (the story's, or `quick/…` for a quick fix). A new branch is cut from the repository's
   * default branch (setting `platform.runBranchBase`), not whatever happened to be checked out. With uncommitted
   * changes in the way, the user picks: stash them, bring them along, or cancel. Throws when the checkout fails — a
   * conflict, say — so the run stops instead of working (and being diffed) on the wrong branch.
   */
  private async prepareBranch(l: RunLaunch, story: Story | null): Promise<void> {
    const repo = await waitForRepository()
    if (!repo) throw new Error('Open the project’s repository folder in this window first.')
    const name = story ? storyBranchName(story) : quickBranchName(l.prompt ?? '', l.run.id)
    this.runBranches.set(l.run.id, name)
    if (repo.state.HEAD?.name === name) return
    const exists = await repo.getBranch(name).then(
      () => true,
      () => false,
    )
    const gitPath = (await getGitApi())?.git.path
    const git = gitPath ? new GitCli(gitPath, repo.rootUri.fsPath) : undefined
    const dirty = repo.state.workingTreeChanges.length + repo.state.indexChanges.length + (repo.state.untrackedChanges?.length ?? 0) > 0
    if (dirty && git) {
      const pick = await vscode.window.showWarningMessage(
        `${launchLabel(l)} works on ${name}, but you have uncommitted changes on ${repo.state.HEAD?.name ?? 'the current branch'}.`,
        { modal: true, detail: 'Stash them (git stash — restore them later with git stash pop), or bring them along onto the run’s branch.' },
        'Stash and continue',
        'Bring my changes',
      )
      if (!pick) throw new Error('Cancelled: uncommitted changes in the working tree.')
      if (pick === 'Stash and continue') await git.run(['stash', 'push', '--include-untracked', '-m', `sdlc: before ${name}`])
    }
    const base = exists ? undefined : await this.branchBase(git)
    try {
      if (exists) await repo.checkout(name)
      else await repo.createBranch(name, true, base)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      throw new Error(`Could not check out ${name} (${why}). Commit or stash your changes, then start the run again.`)
    }
    if (repo.state.HEAD?.name !== name) {
      throw new Error(`Could not check out ${name}: ${repo.state.HEAD?.name ?? 'a detached HEAD'} is still checked out.`)
    }
    const what = story ? `your work on ${story.key} is now reported` : 'for the quick fix'
    vscode.window.setStatusBarMessage(`$(git-branch) ${exists ? 'Switched to' : `Created from ${base ?? 'the current branch'}`} ${name} — ${what}.`, 6000)
  }

  /**
   * What a new run branch starts from: the default branch (origin's HEAD, else main/master; the local branch when it
   * exists, else origin's), or undefined — the current branch — when the setting says so or none is found.
   */
  private async branchBase(git: GitCli | undefined): Promise<string | undefined> {
    if (!git) return undefined
    const setting = vscode.workspace.getConfiguration('sdlcGovernance.platform').get<string>('runBranchBase', 'default')
    if (setting === 'current') return undefined
    const originHead = (await git.tryRun(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim()
    const names = [...new Set([originHead?.replace(/^origin[/]/, ''), 'main', 'master'].filter((n): n is string => !!n))]
    for (const n of names) {
      if ((await git.tryRun(['rev-parse', '--verify', '--quiet', `refs/heads/${n}`]))?.trim()) return n
    }
    for (const n of names) {
      if ((await git.tryRun(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${n}`]))?.trim()) return `origin/${n}`
    }
    return undefined
  }

  /**
   * After an agent step: commit the files it changed to the run's branch (locally — nothing is pushed), so the branch
   * holds the run's work step by step. Never fails the step: a refused commit (a pre-commit hook, say) is logged and
   * the files stay for the next step's commit.
   */
  private async commitStepFiles(l: RunLaunch, stepId: string, step: CompletingStep, paths: string[], activity: ActivityReporter): Promise<void> {
    if (!vscode.workspace.getConfiguration('sdlcGovernance.platform').get<boolean>('commitEachStep', true)) return
    const repo = await runRepo()
    const branch = this.runBranches.get(l.run.id)
    if (!repo || !branch) return
    if (repo.branch() !== branch) {
      this.deps.log(`Run ${l.run.id}: ${repo.branch() ?? 'a detached HEAD'} is checked out, not ${branch} — step ${stepId} was not committed.`)
      return
    }
    const workKey = l.task && l.storyKey ? taskKey(l.storyKey, l.task.number) : l.storyKey
    try {
      const sha = await commitStep(repo.git, { workKey, agentName: step.agentName, summary: step.summary, paths, runId: l.run.id, stepId })
      if (sha) {
        const n = paths.length
        activity.add({ type: 'tool.called', stepId, tool: 'git commit', summary: `Committed ${n} file${n === 1 ? '' : 's'} to ${branch} (${sha.slice(0, 7)})`, data: { sha, branch } })
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      this.deps.log(`Run ${l.run.id}: could not commit step ${stepId}: ${why}`)
      activity.add({ type: 'tool.failed', stepId, tool: 'git commit', summary: `Could not commit the step’s changes: ${why.slice(0, 300)}` })
    }
  }

  /**
   * story.md (or prompt.md for a quick fix), memory.md and each catalog agent's instructions, under the session
   * folder. Returns the work item text the run starts from.
   */
  private async writeContextFiles(client: PlatformClient, l: RunLaunch, story: Story | null, details: AgentDetail[], files: SessionFiles, sessionDir: string) {
    // Checkpoints an earlier run of the same story left behind (this run's own survive a reload: they are newer).
    const started = Date.parse(l.run.requestedAt ?? l.run.startedAt)
    if (Number.isFinite(started)) await files.clearCheckpoints(sessionDir, started).catch(() => undefined)
    let memoryError: string | undefined
    const memory = await runMemoryMarkdown(client, l.projectKey, l.storyNumber, { runId: l.run.id, via: 'context', prompt: l.prompt }).catch((err: unknown) => {
      memoryError = err instanceof Error ? err.message : String(err)
      this.deps.log(`Run ${l.run.id}: could not load memory: ${memoryError}`)
      return undefined
    })
    const extra = l.prompt?.trim()
    let storyText: string
    if (story && l.storyKey) {
      storyText = storyTaskPrompt(story)
      if (l.task) storyText += `\n\n## Task ${taskKey(l.storyKey, l.task.number)}: ${l.task.title}\n\n${l.task.description || '_No details._'}`
      if (extra) storyText += `\n\n## Additional instructions\n\n${extra}`
      await files.writeText(`${sessionDir}/story.md`, `${storyText}\n`)
    } else {
      storyText = `# Quick fix\n\n${extra || '_No description._'}`
      await files.writeText(`${sessionDir}/prompt.md`, `${storyText}\n`)
    }
    // A failed fetch must not read as "nothing known": say so, and point at the tool that fetches it fresh.
    const noMemory = memoryError
      ? `_The project’s memory could not be loaded when the run started (${memoryError.slice(0, 200)}). Call \`sdlc_get_memory\` to load it before relying on it._`
      : '_No project knowledge yet._'
    await files.writeText(`${sessionDir}/memory.md`, `${memory ?? noMemory}\n\n${memoryOutboxHint(sessionDir)}\n`)

    const bySlug = new Map(details.map((a) => [a.slug, a]))
    const agentFiles: Record<string, { instructions: string; file?: string }> = {}
    for (const a of details.filter((x) => x.kind === 'agent')) {
      const file = `${sessionDir}/agents/${a.slug}.md`
      await files.writeText(file, `# ${a.name}\n\n${a.description ?? ''}\n\n${a.instructions}\n`)
      agentFiles[a.slug] = { instructions: a.instructions, file }
    }
    return { memory, storyText, bySlug, agentFiles }
  }

  // ─── Starting an orchestrator-driven run ──────────────────────────────────────────────────────

  /**
   * The platform drives the workflow: prepare the session for every harness the run needs (the run's own and each
   * step's), host each one, and open them lazily as their steps come up. No local runtime, no external dispatcher.
   */
  private async startOrchestrated(l: RunLaunch): Promise<void> {
    const client = this.deps.platform.client()
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!client) throw new Error('Not connected to the platform.')
    if (!folder) throw new Error('Open the story’s repository folder in this window first.')
    const harnesses: Harness[] = []
    const missing: string[] = []
    for (const id of runHarnesses(l)) {
      const h = findHarness(id)
      if (h) harnesses.push(h)
      else missing.push(harnessLabel(id))
    }
    if (missing.length) throw new Error(`${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} not installed in this VS Code window.`)
    const byId = new Map(harnesses.map((h) => [h.id, h]))
    const harnessOf = (nodeId: string): string => l.stepHarnesses[nodeId] ?? l.engine

    const { story, workflow, agentNodes, details, missing: missingCatalog } = await this.loadRunContext(client, l)
    await this.prepareBranch(l, story)
    await this.ensureConsent(listOf(harnesses.map((h) => h.label)))
    await this.beginRunChanges(l.run.id)

    const gitPath = (await getGitApi())?.git.path
    const files = new SessionFiles(folder.uri, gitPath)
    const sessionDir = launchSessionDir(l)
    const runId = l.run.id
    harnessRuns.markOrchestrated(runId)

    await this.bridge.start()
    const activity = new ActivityReporter(l.projectKey, runId, () => this.deps.platform.client(), this.deps.context.workspaceState, this.deps.log)
    const allowPath = negate(makeExcluder(vscode.workspace.getConfiguration('sdlcGovernance').get<string[]>('platform.diffExclude', DEFAULT_DIFF_EXCLUDE)))
    const { bySlug, agentFiles } = await this.writeContextFiles(client, l, story, details, files, sessionDir)
    const outbox = this.openOutbox(l, files, folder, sessionDir, activity)
    if (missingCatalog.length) activity.add({ type: 'nudge', summary: `Could not load ${listOf(missingCatalog)}: those steps run without them` })
    this.usage.set(runId, { reader: new TranscriptUsage(Date.parse(l.run.startedAt) || Date.now()), readAt: 0 })

    // Each step's skills go where the harness that runs it looks for them.
    const skillsByNode: Record<string, SkillRef[]> = {}
    for (const node of agentNodes) {
      const h = byId.get(harnessOf(node.id))
      const skillsDir = h ? skillsDirFor(h) : undefined
      const refs: SkillRef[] = []
      for (const slug of Array.isArray(node.data.skills) ? node.data.skills : []) {
        const skill = bySlug.get(slug)
        if (!skill) continue
        const file = skillsDir ? `${skillsDir}/sdlc-${slug}/SKILL.md` : `${sessionDir}/skills/${slug}.md`
        const body = skillsDir
          ? `---\nname: sdlc-${slug}\ndescription: ${JSON.stringify((skill.description ?? skill.name).slice(0, 300))}\n---\n\n${skill.instructions}\n`
          : `# Skill: ${skill.name}\n\n${skill.description ?? ''}\n\n${skill.instructions}\n`
        await files.writeText(file, body)
        refs.push({ slug, name: skill.name, path: file })
      }
      skillsByNode[node.id] = refs
    }

    const title = l.task && l.storyKey ? `${taskKey(l.storyKey, l.task.number)} · ${l.task.title}` : launchLabel(l)
    const run = new OrchestratedRun(
      {
        bridge: this.bridge,
        client: () => this.deps.platform.client(),
        clientId: this.deps.clientId,
        log: this.deps.log,
        onHook: (target, engine, payload) => this.onHook(target, engine, payload, allowPath),
        watchFiles: (target) => this.watchFiles(target, folder, allowPath),
        onEnd: (id, outcome, reason) => void this.finishOrchestrated(id, outcome, reason),
        // Before a step completes: save the notes it left in the memory outbox, snapshot what it changed, and commit
        // the step's files to the run's branch.
        reportChanges: async (id, stepId, step) => {
          await outbox.flush(stepId)
          const files = await this.runChanges.report(l.projectKey, id, stepId)
          if (stepId && step && files?.length) await this.commitStepFiles(l, stepId, step, files, activity)
          return files
        },
        takeTokens: (id, stepId) => harnessRuns.takeTokens(id, stepId),
      },
      {
        launch: l,
        files,
        sessionDir,
        activity,
        title,
        skillsByNode,
        agents: agentFiles,
        orchestration: {
          runId,
          ...launchTarget(l, story),
          workflowName: workflow.name,
          sessionDir,
          steps: agentNodes.map((n) => ({
            label: n.label || n.id,
            agentName: typeof n.data.agentName === 'string' ? n.data.agentName : null,
            skills: (skillsByNode[n.id] ?? []).map((s) => s.slug),
            harness: harnessOf(n.id),
          })),
        },
      },
    )
    try {
      for (const h of harnesses) await run.host(h)
    } catch (err) {
      run.dispose()
      outbox.dispose()
      await activity.close()
      throw err
    }
    this.orchestrated.set(runId, run)
    this.outboxes.set(runId, outbox)
    this.deps.log(`Run ${runId} is driven by the platform; hosting ${listOf(harnesses.map((h) => h.label))}.`)

    // Steps that came up while the run was being prepared (the platform re-sends them every ~30 s anyway).
    const buffered = this.stepBuffer.get(runId) ?? []
    this.stepBuffer.delete(runId)
    for (const e of buffered) await run.onStep(e)
    void run.refresh()
  }

  /**
   * The run's memory outbox (`<session>/memory-out/*.md`): notes an agent writes there are saved to the platform —
   * when they appear, before each step completes, and when the run ends. One flush at a time, so none is sent twice.
   */
  private openOutbox(l: RunLaunch, files: SessionFiles, folder: vscode.WorkspaceFolder, sessionDir: string, activity: ActivityReporter): Outbox {
    const dir = `${sessionDir}/${MEMORY_OUT_DIR}`
    let chain: Promise<void> = Promise.resolve()
    const flush = (stepId?: string): Promise<void> => {
      chain = chain.catch(() => undefined).then(() => this.flushOutbox(l, files, dir, activity, stepId))
      return chain.catch(() => undefined)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), OUTBOX_SETTLE_MS)
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${dir}/*.md`))
    watcher.onDidCreate(later)
    watcher.onDidChange(later)
    return {
      flush,
      dispose: () => {
        if (timer) clearTimeout(timer)
        watcher.dispose()
      },
    }
  }

  private async flushOutbox(l: RunLaunch, files: SessionFiles, dir: string, activity: ActivityReporter, stepId?: string): Promise<void> {
    const client = this.deps.platform.client()
    if (!client) return
    for (const name of (await files.list(dir)).filter((n) => /\.md$/i.test(n)).sort()) {
      const text = await files.read(`${dir}/${name}`)
      const note = text ? parseMemoryNote(text, name) : undefined
      if (!note) continue
      const input = { ...note, runId: l.run.id, ...(stepId ? { stepId } : {}) }
      try {
        const item = l.storyNumber != null ? await client.addStoryMemory(l.projectKey, l.storyNumber, input) : await client.addProjectMemory(l.projectKey, input)
        await files.move(`${dir}/${name}`, `${dir}/sent/${name}`)
        activity.add({ type: 'memory.written', stepId: stepId ?? null, summary: `${note.kind}: ${item.title}`, data: { itemId: item.id, status: item.status, via: 'outbox' } })
      } catch (err) {
        this.deps.log(`Run ${l.run.id}: could not save the memory note ${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private async finishOrchestrated(runId: string, outcome: 'done' | 'stopped', reason?: string): Promise<void> {
    const run = this.orchestrated.get(runId)
    if (!run) return
    this.orchestrated.delete(runId)
    const outbox = this.outboxes.get(runId)
    this.outboxes.delete(runId)
    if (outbox) {
      await outbox.flush()
      outbox.dispose()
    }
    await run.finish(outcome, reason ?? (outcome === 'done' ? 'The run completed.' : 'The run stopped.'))
    // The config files are shared by every run in this window: clean them up only when the last one ends (a queued
    // run counts — it is about to use them).
    if (!this.hostingRuns()) await run.unwire()
    this.runBranches.delete(runId)
    this.usage.delete(runId)
    void this.endRunChanges(run.projectKey, runId, run.title, outcome)
    setTimeout(() => harnessRuns.forget(runId), 90_000)
    void this.startNextQueued()
  }

  // ─── While a run lasts ────────────────────────────────────────────────────────────────────────

  private onChannelEvent(e: Parameters<Parameters<ExternalEngineDispatcher['onEvent']>[0]>[0]): void {
    const a = this.active.get(e.runId)
    if (!a) return
    if (e.type === 'delivered') {
      const stepId = e.input.stepId ?? e.input.nodeId ?? null
      a.currentStep = stepId ?? undefined
      a.currentPhase = e.input.phase
      if (stepId && !a.seenSteps.has(stepId)) {
        a.seenSteps.add(stepId)
        a.activity.add({ type: 'step.started', stepId, agentName: e.input.agentName, summary: e.input.agentName })
      }
      if (e.input.phase === 'execute') a.activity.add({ type: 'agent.started', stepId, agentName: e.input.agentName, agentType: e.input.agentId, summary: 'Executing the approved plan' })
      if (a.tier === 'files') void this.writeNext(a, e.input.phase, stepId ?? '', e.input.agentName, e.input.prompt, e.input.approvedPlan)
    } else if (e.type === 'plan.submitted') {
      a.activity.add({ type: 'plan.submitted', stepId: e.stepId, summary: e.plan })
    } else if (e.type === 'step.completed') {
      for (const slug of e.skillsUsed) {
        harnessRuns.addSkill(e.runId, e.stepId, slug, 'declared')
        a.activity.add({ type: 'skill.used', stepId: e.stepId, skill: slug, data: { evidence: 'declared' } })
      }
      a.activity.add({ type: 'step.completed', stepId: e.stepId, summary: e.summary })
      a.currentPhase = undefined
    }
  }

  private onHook(a: Attributable, engine: string, payload: unknown, allowPath: (p: string) => boolean): void {
    // Relative to the repository root, like the run's diff (the opened folder may be a subfolder of the repository).
    const root = this.runChanges.rootOf(a.runId) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    for (const ev of normalizeHook(engine, payload, allowPath, root)) {
      if (ev.sessionId && !a.sessionLinked) {
        a.sessionLinked = true
        harnessRuns.update(a.runId, { engineSessionId: ev.sessionId })
        // Orchestrator-driven runs are never reported as a whole: the platform takes the session id from this event.
        a.activity.add({ type: 'harness.opened', summary: 'Linked to the harness session', data: { engineSessionId: ev.sessionId.slice(0, 200) } })
      }
      const stepId = a.currentStep ?? null
      if (stepId) {
        if (ev.type === 'skill.used' && ev.skill) harnessRuns.addSkill(a.runId, stepId, ev.skill, 'observed')
        if (ev.type === 'tool.called' || ev.type === 'tool.failed') harnessRuns.addToolCall(a.runId, stepId)
        if (ev.type === 'file.changed' && ev.path) harnessRuns.addFile(a.runId, stepId, ev.path)
      }
      a.activity.add({ ...ev, stepId })
    }
    if (engine === 'claude-code') void this.readUsage(a, payload)
  }

  /**
   * Tokens Claude Code spent since the last read of its transcript (and of a subagent's), attributed to the step it
   * is on — read when a turn or subagent stops, and at most every few seconds while it works.
   */
  private async readUsage(a: Attributable, payload: unknown): Promise<void> {
    const entry = this.usage.get(a.runId)
    const stepId = a.currentStep
    if (!entry || !stepId || !payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    const event = typeof p.hook_event_name === 'string' ? p.hook_event_name : ''
    const stops = event === 'Stop' || event === 'SubagentStop'
    const now = Date.now()
    if (!stops && now - entry.readAt < USAGE_READ_EVERY_MS) return
    entry.readAt = now
    const paths = [p.transcript_path, p.agent_transcript_path].filter((x): x is string => typeof x === 'string' && x.length > 0)
    let tokensIn = 0
    let tokensOut = 0
    for (const path of paths) {
      const u = await entry.reader.read(path)
      tokensIn += u.tokensIn
      tokensOut += u.tokensOut
    }
    if (tokensIn + tokensOut === 0) return
    harnessRuns.addTokens(a.runId, stepId, tokensIn, tokensOut)
    a.activity.add({ type: 'usage', stepId, summary: `${tokensIn + tokensOut} tokens`, data: { tokensIn, tokensOut } })
  }

  private onRun(state: RunState): void {
    const a = this.active.get(state.runId)
    if (!a) return
    if (state.status === 'awaiting_approval') {
      this.deps.external.setWaiting(state.runId, 'approval')
      const stepId = state.pendingApproval?.stepId
      const key = `approval:${stepId}`
      if (stepId && !a.seenSteps.has(key)) {
        a.seenSteps.add(key)
        a.activity.add({ type: 'approval.requested', stepId, summary: state.pendingApproval?.question ?? 'Plan awaiting approval' })
      }
    } else if (state.status === 'running') {
      const running = state.steps.filter((s) => s.status === 'running').at(-1)
      this.deps.external.setWaiting(state.runId, running?.kind === 'gate' ? 'gate' : 'idle')
    }
    for (const s of state.steps) {
      if (s.kind !== 'gate' || !s.gateDecision || a.seenSteps.has(`gate:${s.id}`)) continue
      a.seenSteps.add(`gate:${s.id}`)
      a.activity.add({ type: 'gate.evaluated', stepId: s.id, summary: `${s.label}: ${s.gateDecision.pass ? 'passed' : 'failed'} — ${s.gateDecision.reason}` })
    }
    if (TERMINAL.has(state.status)) void this.finish(state.runId, state.status === 'completed' ? 'done' : 'stopped', state.error)
  }

  /** Whether this window still hosts a run (or is starting one) — then the shared harness config stays. */
  private hostingRuns(): boolean {
    return this.active.size > 0 || this.orchestrated.size > 0 || this.inflight.size > 0 || this.starting.size > 0 || this.queued.length > 0
  }

  private async finish(runId: string, outcome: 'done' | 'stopped', reason?: string): Promise<void> {
    const a = this.active.get(runId)
    if (!a) return
    this.active.delete(runId)
    this.deps.external.releaseRun(runId, outcome, reason ?? (outcome === 'done' ? 'The run completed.' : 'The run stopped.'))
    // Let the harness's last poll see done/stopped before the tools go away.
    setTimeout(() => this.bridge.close(a.endpoints.token), 60_000)
    for (const d of a.disposables) d.dispose()
    if (a.tier === 'files') await a.files.writeText(`${a.sessionDir}/next.md`, `The run is **${outcome === 'done' ? 'done' : 'stopped'}**. ${reason ?? ''}\n`).catch(() => undefined)
    if (!this.hostingRuns()) {
      for (const w of wiringFor(a.harness, { mcpUrl: '', hookUrl: '' })) await a.files.removeWiring(w).catch(() => undefined)
    }
    await a.activity.close()
    void this.endRunChanges(a.projectKey, runId, a.title, outcome)
    setTimeout(() => harnessRuns.forget(runId), 90_000)
    void this.startNextQueued()
  }

  // ─── File checkpoints (harnesses without MCP) ─────────────────────────────────────────────────

  private async writeNext(a: Active, phase: 'plan' | 'execute', stepId: string, agentName: string, prompt: string, approvedPlan?: string): Promise<void> {
    const dir = `${a.sessionDir}/${stepId}`
    const text =
      phase === 'plan'
        ? `# Step ${stepId} — PLAN as ${agentName}\n\nWrite your plan (no file changes yet) to \`${dir}/plan.md\`.\n\n## Instructions\n\n${prompt}\n`
        : `# Step ${stepId} — EXECUTE as ${agentName}\n\nThe plan below was approved. Do the work, then write a short summary to \`${dir}/done.md\` (add a line \`Skills used: a, b\` if you used skills).\n\n## Approved plan\n\n${approvedPlan ?? ''}\n\n## Instructions\n\n${prompt}\n`
    await a.files.writeText(`${a.sessionDir}/next.md`, text)
  }

  private watchCheckpoints(a: Active): vscode.Disposable {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return { dispose: () => {} }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${a.sessionDir}/*/{plan,done}.md`))
    const onFile = async (uri: vscode.Uri) => {
      const parts = uri.path.split('/')
      const name = parts.at(-1)
      const stepId = parts.at(-2) ?? ''
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).trim()
      if (!text) return
      try {
        if (name === 'plan.md') this.deps.external.channel.submitPlan(a.runId, stepId, text)
        else {
          const skills = /^skills used:\s*(.+)$/im.exec(text)?.[1].split(/[,\s]+/).filter(Boolean) ?? []
          this.deps.external.channel.complete(a.runId, stepId, text, { skillsUsed: skills })
        }
      } catch (err) {
        this.deps.log(String(err))
      }
    }
    watcher.onDidCreate((u) => void onFile(u))
    watcher.onDidChange((u) => void onFile(u))
    return watcher
  }

  /** For harnesses without hooks: files changed while a step executes are that step's files. */
  private watchFiles(a: Attributable, folder: vscode.WorkspaceFolder, allowPath: (p: string) => boolean): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'))
    const seen = new Set<string>()
    const onChange = (uri: vscode.Uri) => {
      const rel = relativePath(uri.fsPath, this.runChanges.rootOf(a.runId) ?? folder.uri.fsPath)
      if (/(^|\/)(\.git|\.sdlc|node_modules)\//.test(rel) || !allowPath(rel)) return
      const stepId = a.currentPhase === 'execute' ? a.currentStep : undefined
      if (!stepId || seen.has(`${stepId}:${rel}`)) return
      seen.add(`${stepId}:${rel}`)
      harnessRuns.addFile(a.runId, stepId, rel)
      a.activity.add({ type: 'file.changed', stepId, path: rel })
    }
    watcher.onDidCreate(onChange)
    watcher.onDidChange(onChange)
    watcher.onDidDelete(onChange)
    return watcher
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    for (const a of this.active.values()) for (const d of a.disposables) d.dispose()
    for (const r of this.orchestrated.values()) r.dispose()
    this.bridge.dispose()
  }
}

const negate = (f: (p: string) => boolean) => (p: string) => !f(p)

/** The harnesses a run needs: its own, and for orchestrator-driven runs every agent step's. */
function runHarnesses(l: RunLaunch): string[] {
  return l.driver === 'orchestrator' ? [...new Set([l.engine, ...Object.values(l.stepHarnesses)])] : [l.engine]
}

/** `A`, `A and B`, `A, B and C`. */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** A waiting step from the active-runs list, as the `run.step` event the platform would have sent for it. */
function waitingStepEvent(r: ActiveRun, w: WaitingStep): RunStepEvent {
  return {
    type: 'run.step',
    targetUserId: '',
    runId: r.runId,
    projectKey: r.projectKey,
    storyNumber: r.storyNumber,
    stepId: w.stepId,
    nodeId: w.nodeId,
    phase: w.phase,
    harness: w.harness,
    clientId: r.clientId,
  }
}
