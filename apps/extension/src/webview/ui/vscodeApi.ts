// Phase 5A — the webview's typed handle to the VS Code API. `acquireVsCodeApi()` may be called only
// once per webview load, so we wrap it in a module singleton. State persisted via setState survives a
// webview reload (retainContextWhenHidden + getState), satisfying the "survives reload" exit criterion.

import type { WebviewToHost, HostToWebview } from '../messages'
import type { WorkflowSpec } from '../../runtime/spec'
import type { RunState } from '../../runtime/port'
import type { AgentSummary, PlatformWorkflowView } from '../messages'

/** What we stash in webview state so a reload re-renders without a host round-trip. */
export interface PersistedState {
  /** 'view' = read-only canvas; 'builder' = full editor; 'platform' = a project workflow + its step mapping */
  mode?: 'view' | 'builder' | 'platform'
  // platform-mode fields
  platformView?: PlatformWorkflowView
  // view-mode fields
  spec?: WorkflowSpec
  runState?: RunState
  agents?: AgentSummary[]
  // builder-mode fields
  builderState?: {
    spec: WorkflowSpec
    isReadOnly: boolean
    workflowId: string
    agents: AgentSummary[]
  }
}

interface VsCodeApi {
  postMessage(message: WebviewToHost): void
  getState(): PersistedState | undefined
  setState(state: PersistedState): void
}

declare function acquireVsCodeApi(): VsCodeApi

export const vscode = acquireVsCodeApi()

/** Strongly-typed message subscription helper. Returns an unsubscribe fn. */
export function onHostMessage(handler: (msg: HostToWebview) => void): () => void {
  const listener = (ev: MessageEvent<HostToWebview>) => handler(ev.data)
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
