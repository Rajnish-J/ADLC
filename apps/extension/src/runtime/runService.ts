// Phase 4 — RunService: the extension-facing orchestration façade over the WorkflowRuntime port.
//
// Owns the live runtime (MockWorkflowRuntime now; FoundryWorkflowRuntime later — same port), caches run
// states for the Runs tree, mirrors every transition into the append-only RunAuditStore, and re-exposes a
// single change event the view subscribes to. Swapping runtimes is a one-line change in the extension wiring.

import * as vscode from 'vscode'
import type { RunState, StartRunArgs, WorkflowRuntime } from './port'
import type { WorkflowSpec } from './spec'
import { deriveRunAuditEvents, RunAuditStore } from './runAudit'
import type { RunServicePort, StartRunOptions } from './runServicePort'

/** An approval decision on the step a run was paused on. */
export interface RunDecision {
  runId: string
  stepId: string
  approve: boolean
  actor: string
  comment?: string
}

export class RunService implements RunServicePort {
  private readonly states = new Map<string, RunState>()
  private readonly seen = new Map<string, Set<string>>()
  private readonly started = new Set<string>()
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  /** Fires whenever any run's state changes — drives the Runs tree. */
  readonly onDidChange = this._onDidChange.event

  private readonly _onDidChangeRun = new vscode.EventEmitter<RunState>()
  /** Fires with the full run state on every transition — drives live chat streaming. */
  readonly onDidChangeRun = this._onDidChangeRun.event

  private readonly _onDidDecide = new vscode.EventEmitter<RunDecision>()
  /**
   * Fires when someone approves or rejects the step a run is paused on. The run state itself doesn't keep the
   * decision, so the platform reporter listens here to record who decided and why.
   */
  readonly onDidDecide = this._onDidDecide.event

  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly audit: RunAuditStore,
    /** Injectable for deterministic tests; defaults to wall clock. */
    private readonly now: () => Date = () => new Date(),
  ) {
    this.runtime.onRunUpdate((state) => {
      this.states.set(state.runId, state)
      void this.flushAudit(state)
      this._onDidChange.fire()
      this._onDidChangeRun.fire(state)
    })
  }

  private async flushAudit(state: RunState): Promise<void> {
    const seen = this.seen.get(state.runId) ?? new Set<string>()
    this.seen.set(state.runId, seen)
    const emitStarted = !this.started.has(state.runId)
    if (emitStarted) this.started.add(state.runId)
    const events = deriveRunAuditEvents(state, seen, this.now().toISOString(), { emitStarted })
    await this.audit.append(events)
  }

  /**
   * Re-hydrate runs that outlived the previous extension-host session (see WorkflowRuntime.restoreRuns), so a
   * run paused on a plan approval shows up in the Runs tree / canvas after a reload and can be approved.
   * Returns how many runs were restored. A no-op for engines without a durable store.
   *
   * The audit-dedupe sets are primed from what each restored run already recorded, so restoring never writes
   * a duplicate `run.started`/`step`/`approval.requested` row. A run found to have died mid-step comes back
   * `failed`; that terminal outcome IS new information, so it is flushed (and only it) to the audit store.
   */
  async restore(): Promise<number> {
    const restored = (await this.runtime.restoreRuns?.()) ?? []
    for (const state of restored) {
      this.states.set(state.runId, state)
      const seen = new Set<string>()
      for (const step of state.steps) if (step.status !== 'running') seen.add(step.id)
      if (state.pendingApproval) seen.add(`approval-req:${state.pendingApproval.stepId}`)
      this.seen.set(state.runId, seen)
      this.started.add(state.runId)
    }
    for (const state of restored) {
      if (state.status === 'failed' || state.status === 'cancelled' || state.status === 'completed') {
        await this.flushAudit(state)
      }
    }
    if (restored.length > 0) this._onDidChange.fire()
    return restored.length
  }

  async startRun(
    spec: WorkflowSpec,
    actor: string,
    inputs?: Record<string, unknown>,
    opts?: StartRunOptions,
  ): Promise<RunState> {
    const args: StartRunArgs = { spec, actor, inputs, runId: opts?.runId }
    const state = await this.runtime.startRun(args)
    this.rememberSpec(state.runId, spec)
    return state
  }

  // ─── The spec each run was started with ────────────────────────────────────────────────────────
  // A run's spec isn't always in the workspace's workflow store (a project workflow comes from the platform), so
  // the canvas asks here first. Persisted for the most recent runs so restored runs still open after a reload.

  private static readonly SPECS_KEY = 'sdlcGovernance.runSpecs'
  private static readonly SPECS_KEPT = 50
  private readonly specs = new Map<string, WorkflowSpec>()
  private specStore: vscode.Memento | undefined

  /** Keep run specs across reloads in `memento` (e.g. the extension's globalState). */
  persistSpecsIn(memento: vscode.Memento): void {
    this.specStore = memento
    const saved = memento.get<Record<string, WorkflowSpec>>(RunService.SPECS_KEY, {})
    for (const [runId, spec] of Object.entries(saved)) if (!this.specs.has(runId)) this.specs.set(runId, spec)
  }

  /** The spec a run was started with, if this window started (or restored) it. */
  specOf(runId: string): WorkflowSpec | undefined {
    return this.specs.get(runId)
  }

  private rememberSpec(runId: string, spec: WorkflowSpec): void {
    this.specs.delete(runId)
    this.specs.set(runId, spec)
    // Map order is insertion order: drop the oldest beyond the cap.
    while (this.specs.size > RunService.SPECS_KEPT) this.specs.delete(this.specs.keys().next().value as string)
    void this.specStore?.update(RunService.SPECS_KEY, Object.fromEntries(this.specs))
  }

  async approve(runId: string, actor: string, comment?: string): Promise<RunState> {
    return this.decide(runId, { approve: true, actor, comment })
  }

  async reject(runId: string, actor: string, comment?: string): Promise<RunState> {
    return this.decide(runId, { approve: false, actor, comment })
  }

  private async decide(runId: string, decision: { approve: boolean; actor: string; comment?: string }): Promise<RunState> {
    const stepId = this.states.get(runId)?.pendingApproval?.stepId
    const state = await this.runtime.submitApproval(runId, decision)
    if (stepId) this._onDidDecide.fire({ runId, stepId, ...decision })
    return state
  }

  async cancel(runId: string): Promise<RunState> {
    return this.runtime.cancelRun(runId)
  }

  /** All runs, most recent first. */
  list(): RunState[] {
    return [...this.states.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  get(runId: string): RunState | undefined {
    return this.states.get(runId)
  }
}
