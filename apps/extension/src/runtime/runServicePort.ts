// The extension-facing run façade as an interface, so the Runs view, canvas and chat can be driven either by
// the in-process RunService (local mode) or by a backend-backed implementation (connected mode) without
// change. Framework-free: `vscode.Event` satisfies the listener shape structurally.

import type { RunState } from './port'
import type { WorkflowSpec } from './spec'

export interface Disposable {
  dispose(): unknown
}

export interface StartRunOptions {
  /** Caller-chosen run id — lets the caller bind per-run dispatch context before the run starts. */
  runId?: string
}

export interface RunServicePort {
  /** Fires whenever any run's state changes — drives the Runs tree. */
  readonly onDidChange: (listener: () => unknown) => Disposable
  /** Fires with the full run state on every transition — drives live chat streaming and the canvas. */
  readonly onDidChangeRun: (listener: (state: RunState) => unknown) => Disposable
  /** Re-hydrate runs that outlived the previous session. Returns how many were restored. */
  restore(): Promise<number>
  startRun(spec: WorkflowSpec, actor: string, inputs?: Record<string, unknown>, opts?: StartRunOptions): Promise<RunState>
  approve(runId: string, actor: string, comment?: string): Promise<RunState>
  reject(runId: string, actor: string, comment?: string): Promise<RunState>
  cancel(runId: string): Promise<RunState>
  /** All runs, most recent first. */
  list(): RunState[]
  get(runId: string): RunState | undefined
}
