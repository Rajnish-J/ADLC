// Mirrors agent workflow runs to the SDLC platform, so a story's runs show in the web app and in every teammate's
// VS Code. Runs still execute here, locally; the platform records each state change (throttled to one report per
// second per run, immediately when a run finishes). A run belongs to a story when it was started from the story
// (inputs.storyKey) or, failing that, when it started while a story branch was checked out.

import * as vscode from 'vscode'
import type { ApprovalRecord } from '@sdlc/contracts'
import type { AgentFileWrite } from '../../runtime/dispatch/lmAgentDispatcher'
import type { RunState } from '../../runtime/port'
import type { RunDecision, RunService } from '../../runtime/runService'
import { PlatformError, type PlatformClient } from '../platformClient'
import { harnessRuns } from '../session/harnessRunInfo'
import { TERMINAL_RUN_STATUSES, toRunReport } from './runSnapshot'
import { storyFromKey, type StoryRef } from './storyRef'

const THROTTLE_MS = 1_000

interface Tracked {
  story: StoryRef
  latest?: RunState
  timer?: ReturnType<typeof setTimeout>
  inFlight?: Promise<void>
  dirty: boolean
  /** Set when the platform refused this run (e.g. the story isn't the developer's): stop reporting it. */
  ignored: boolean
  changedFiles: Map<string, Set<string>>
  approvals: Map<string, ApprovalRecord>
}

export interface RunReporterDeps {
  runs: RunService
  /** The LM dispatcher's write events (absent in mock dispatch mode — then no per-step files are known). */
  onDidWriteFile?: vscode.Event<AgentFileWrite>
  client: () => PlatformClient | undefined
  /** The story of the branch checked out right now, for runs not started from a story. */
  activeStory: () => StoryRef | undefined
  log: (message: string) => void
}

export class RunReporter implements vscode.Disposable {
  private readonly runs = new Map<string, Tracked>()
  private readonly subscriptions: vscode.Disposable[] = []

  constructor(private readonly deps: RunReporterDeps) {
    this.subscriptions.push(deps.runs.onDidChangeRun((state) => this.onRun(state)))
    this.subscriptions.push(deps.runs.onDidDecide((d) => this.onDecide(d)))
    if (deps.onDidWriteFile) this.subscriptions.push(deps.onDidWriteFile((w) => this.onWrite(w)))
    // Runs in a harness: skills, tool calls and files arrive from the SDLC tools and hooks, not the dispatcher.
    this.subscriptions.push(
      harnessRuns.onDidChange((runId) => {
        const t = this.runs.get(runId)
        if (!t || t.ignored) return
        t.dirty = true
        this.flushSoon(runId, THROTTLE_MS)
      }),
    )
  }

  private track(state: RunState): Tracked | undefined {
    const existing = this.runs.get(state.runId)
    if (existing) return existing
    const story = storyFromKey(typeof state.inputs?.storyKey === 'string' ? state.inputs.storyKey : undefined) ?? this.deps.activeStory()
    if (!story) return undefined
    const tracked: Tracked = { story, dirty: false, ignored: false, changedFiles: new Map(), approvals: new Map() }
    this.runs.set(state.runId, tracked)
    return tracked
  }

  private onRun(state: RunState): void {
    if (!this.deps.client()) return
    // Orchestrator-driven runs never start in the local runtime; should one ever appear here, its state belongs to
    // the platform, so it is never overwritten with a local snapshot.
    if (harnessRuns.isOrchestrated(state.runId)) return
    const t = this.track(state)
    if (!t || t.ignored) return
    t.latest = state
    t.dirty = true
    if (TERMINAL_RUN_STATUSES.has(state.status)) this.flushSoon(state.runId, 0)
    else this.flushSoon(state.runId, THROTTLE_MS)
  }

  private onDecide(d: RunDecision): void {
    const t = this.runs.get(d.runId)
    if (!t) return
    t.approvals.set(d.stepId, { approve: d.approve, comment: d.comment?.slice(0, 2_000), actor: d.actor.slice(0, 320) })
    t.dirty = true
    this.flushSoon(d.runId, THROTTLE_MS)
  }

  private onWrite(w: AgentFileWrite): void {
    const t = this.runs.get(w.runId)
    if (!t) return
    // Attribute to the step that wrote it; without a step id, to the step running right now.
    const stepId = w.stepId ?? t.latest?.steps.filter((s) => s.status === 'running').at(-1)?.id
    if (!stepId) return
    const files = t.changedFiles.get(stepId) ?? new Set<string>()
    files.add(w.path)
    t.changedFiles.set(stepId, files)
    t.dirty = true
  }

  private flushSoon(runId: string, delay: number): void {
    const t = this.runs.get(runId)
    if (!t) return
    if (t.timer && delay > 0) return // already scheduled
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      t.timer = undefined
      void this.flush(runId)
    }, delay)
  }

  private async flush(runId: string): Promise<void> {
    const t = this.runs.get(runId)
    const client = this.deps.client()
    if (!t || !t.latest || !client || t.ignored) return
    if (t.inFlight) {
      await t.inFlight
      if (t.dirty) this.flushSoon(runId, 0)
      return
    }
    if (!t.dirty) return
    t.dirty = false
    const state = t.latest
    const meta = harnessRuns.get(runId)
    const files = new Map([...t.changedFiles].map(([k, v]) => [k, [...v]]))
    if (meta) for (const s of state.steps) files.set(s.id, [...new Set([...(files.get(s.id) ?? []), ...harnessRuns.files(runId, s.id)])])
    const report = toRunReport(state, {
      changedFiles: files,
      approvals: t.approvals,
      spec: this.deps.runs.specOf(runId),
      harness: meta
        ? { ...meta, skillsUsed: (stepId) => harnessRuns.skillsUsed(runId, stepId), toolCalls: (stepId) => harnessRuns.toolCalls(runId, stepId) }
        : undefined,
    })
    t.inFlight = client
      .reportRun(t.story.projectKey, t.story.number, runId, report)
      .then(() => undefined)
      .catch((err: unknown) => {
        if (err instanceof PlatformError && (err.status === 403 || err.status === 404)) {
          t.ignored = true
          this.deps.log(`Run ${runId} is not recorded on ${t.story.projectKey}-${t.story.number}: ${err.message}`)
        } else {
          t.dirty = true // try again with the next change, or shortly if this was the last one
          this.deps.log(`Could not report run ${runId}: ${err instanceof Error ? err.message : String(err)}`)
          if (TERMINAL_RUN_STATUSES.has(state.status)) setTimeout(() => this.flushSoon(runId, 0), 5_000)
        }
      })
      .finally(() => {
        t.inFlight = undefined
      })
    await t.inFlight
    if (t.dirty && !t.ignored) this.flushSoon(runId, THROTTLE_MS)
    else if (TERMINAL_RUN_STATUSES.has(state.status)) {
      // Keep it briefly for a late approval or file event, then forget it.
      setTimeout(() => {
        if (!this.runs.get(runId)?.dirty) this.runs.delete(runId)
      }, 60_000)
    }
  }

  dispose(): void {
    for (const t of this.runs.values()) if (t.timer) clearTimeout(t.timer)
    for (const s of this.subscriptions) s.dispose()
  }
}
