// What this window knows about each run executing in a harness, beyond the runtime's own state: the harness and
// model, the task, and per step the skills used, tool calls and files touched (from the SDLC tools and hooks). The
// run reporter folds it into every report, so the platform's runs, steps and evaluations carry it.

import * as vscode from 'vscode'
import type { SkillUse } from '@sdlc/contracts'

export interface HarnessRunMeta {
  engine: string
  engineModel: string | null
  engineSessionId: string | null
  workflowId: string | null
  workflowVersion: number | null
  taskNumber: number | null
}

interface StepDetail {
  skillsUsed: Map<string, SkillUse['evidence']>
  toolCalls: number
  files: Set<string>
  /** Tokens spent on the step and not yet sent to the platform (with the plan or the completion). */
  tokensIn: number
  tokensOut: number
  /** Whether usage was ever recorded for the step (otherwise its tokens are unknown, not zero). */
  hasTokens: boolean
}

class HarnessRuns {
  private readonly meta = new Map<string, HarnessRunMeta>()
  private readonly steps = new Map<string, Map<string, StepDetail>>()
  /** Runs the platform's orchestrator drives: this window only hosts their harnesses and never reports snapshots. */
  private readonly orchestrated = new Set<string>()
  private readonly _onDidChange = new vscode.EventEmitter<string>()
  /** Fires with a run id whenever its harness detail changed (the reporter re-reports it). */
  readonly onDidChange = this._onDidChange.event

  set(runId: string, meta: HarnessRunMeta): void {
    this.meta.set(runId, meta)
    this._onDidChange.fire(runId)
  }

  update(runId: string, patch: Partial<HarnessRunMeta>): void {
    const m = this.meta.get(runId)
    if (!m) return
    this.meta.set(runId, { ...m, ...patch })
    this._onDidChange.fire(runId)
  }

  get(runId: string): HarnessRunMeta | undefined {
    return this.meta.get(runId)
  }

  markOrchestrated(runId: string): void {
    this.orchestrated.add(runId)
  }

  /** Whether the platform's orchestrator drives this run (its state is the platform's, not a local snapshot). */
  isOrchestrated(runId: string): boolean {
    return this.orchestrated.has(runId)
  }

  private step(runId: string, stepId: string): StepDetail {
    const run = this.steps.get(runId) ?? new Map<string, StepDetail>()
    this.steps.set(runId, run)
    const d = run.get(stepId) ?? { skillsUsed: new Map(), toolCalls: 0, files: new Set(), tokensIn: 0, tokensOut: 0, hasTokens: false }
    run.set(stepId, d)
    return d
  }

  addSkill(runId: string, stepId: string, slug: string, evidence: SkillUse['evidence']): void {
    const d = this.step(runId, stepId)
    if (d.skillsUsed.get(slug) === 'observed') return
    d.skillsUsed.set(slug, evidence)
    this._onDidChange.fire(runId)
  }

  addToolCall(runId: string, stepId: string): void {
    this.step(runId, stepId).toolCalls++
    this._onDidChange.fire(runId)
  }

  addFile(runId: string, stepId: string, path: string): void {
    this.step(runId, stepId).files.add(path)
    this._onDidChange.fire(runId)
  }

  addTokens(runId: string, stepId: string, tokensIn: number, tokensOut: number): void {
    const d = this.step(runId, stepId)
    d.tokensIn += tokensIn
    d.tokensOut += tokensOut
    d.hasTokens = true
    this._onDidChange.fire(runId)
  }

  /** The tokens recorded for the step since the last call (they are sent once), or undefined if none ever were. */
  takeTokens(runId: string, stepId: string): { tokensIn: number; tokensOut: number } | undefined {
    const d = this.steps.get(runId)?.get(stepId)
    if (!d?.hasTokens) return undefined
    const out = { tokensIn: d.tokensIn, tokensOut: d.tokensOut }
    d.tokensIn = 0
    d.tokensOut = 0
    return out
  }

  skillsUsed(runId: string, stepId: string): SkillUse[] {
    return [...(this.steps.get(runId)?.get(stepId)?.skillsUsed ?? [])].map(([slug, evidence]) => ({ slug, evidence }))
  }

  toolCalls(runId: string, stepId: string): number | null {
    const d = this.steps.get(runId)?.get(stepId)
    return d ? d.toolCalls : null
  }

  files(runId: string, stepId: string): string[] {
    return [...(this.steps.get(runId)?.get(stepId)?.files ?? [])]
  }

  forget(runId: string): void {
    this.meta.delete(runId)
    this.steps.delete(runId)
    this.orchestrated.delete(runId)
  }
}

/** One per extension host. */
export const harnessRuns = new HarnessRuns()
