// Typed postMessage protocol between the extension host and the canvas/builder webview.
//
// Shared by both sides: the host (workflowCanvasPanel.ts, Node) posts HostToWebview messages; the
// webview UI (src/webview/ui, browser) posts WebviewToHost messages. Pure types only (no `vscode`,
// no DOM) so it compiles under both tsconfig.json and tsconfig.webview.json.

import type { WorkflowSpec } from '../runtime/spec'
import type { RunState } from '../runtime/port'
import type { SpecNodeKind } from '../runtime/spec'
import type { AgentSummary } from '../discovery/agentModel'

export type { AgentSummary } from '../discovery/agentModel'

export type AiAssistant = 'copilot' | 'claude-code' | 'codex'

/** An agent a project workflow step can be mapped to (the platform's project agent list, trimmed). */
export interface PlatformAgentOption {
  slug: string
  name: string
  description: string
  sdlcStage: string
  /** `builtin` or `repo` (discovered in the project's codebase). */
  source: string
  enabled: boolean
  /** The caller's role allows mapping / running it. */
  usable: boolean
}

/**
 * A harness an agent step can be pinned to (the known harnesses, plus custom ones installed here). Sent by the host
 * so the webview bundle carries no @sdlc/contracts runtime code.
 */
export interface HarnessOption {
  id: string
  label: string
  /** Installed in this VS Code window. */
  installed: boolean
}

/** A project workflow from the SDLC platform, opened in the canvas with its step → agent mapping. */
export interface PlatformWorkflowView {
  projectKey: string
  projectName: string
  workflowId: string
  name: string
  version: number
  isDefault: boolean
  spec: WorkflowSpec
  /** May change the mapping (`workflow.edit`); the API re-checks. */
  canEdit: boolean
  /** Agents of kind `agent` visible in the project. */
  agents: PlatformAgentOption[]
  /** Harnesses a step can be pinned to (absent in views persisted by older versions). */
  harnesses?: HarnessOption[]
}

/** The project workflow a local workflow corresponds to (the local default ↔ the project's default). */
export interface PlatformWorkflowLink {
  projectKey: string
  workflowId: string
  name: string
}

/** Host → webview. */
export type HostToWebview =
  /** Initial render (or full re-render) of a spec in view-only mode, optionally with a run overlay. */
  | { type: 'render'; spec: WorkflowSpec; runState?: RunState; agents?: AgentSummary[] }
  /** A live run-state delta to re-paint node overlays without re-laying-out. */
  | { type: 'runUpdate'; runState: RunState }
  /** Open the full workflow builder (edit or read-only depending on isReadOnly flag). */
  | {
      type: 'renderBuilder'
      spec: WorkflowSpec
      isReadOnly: boolean
      workflowId: string
      agents: AgentSummary[]
      /** When true, the builder opens the "create from agents" modal on mount. */
      createMode?: boolean
      /** Signed in and the workspace maps to a project: where this workflow's agent mapping is edited. */
      platformLink?: PlatformWorkflowLink
      /** Harnesses an agent step can be pinned to (the node panel's "Harness" choice). */
      harnesses?: HarnessOption[]
    }
  /** Open (or re-render) a project workflow from the SDLC platform with its step mapping. */
  | { type: 'renderPlatform'; view: PlatformWorkflowView }
  /** A step's mapping change is in flight (nodeId) or finished (null). */
  | { type: 'platformBusy'; nodeId: string | null }
  /** Agent list refresh in response to a requestAgents message. */
  | { type: 'agentsLoaded'; agents: AgentSummary[] }
  /** Current AI assistant preference, sent in response to getAiPreference or setAiPreference. */
  | { type: 'aiPreferenceLoaded'; assistant: AiAssistant }

/** Webview → host. */
export type WebviewToHost =
  /** The UI has mounted and acquired its api; the host should send the initial render. */
  | { type: 'ready' }
  /** User asked to jump to a node's source (e.g. an agent's manifest file). */
  | { type: 'revealNode'; nodeId: string }
  /** User clicked the Evaluate button on an agent node — run per-agent evaluation. */
  | { type: 'evaluateAgent'; agentId: string }
  /** User clicked the Govern button on an agent node — run per-agent governance check. */
  | { type: 'governAgent'; agentId: string }
  /** User clicked Save in the builder — persist the modified spec. When `silent`, suppress the saved toast (used for auto-save). */
  | { type: 'saveWorkflow'; spec: WorkflowSpec; workflowId: string; silent?: boolean }
  /** User clicked "Delete Workflow" in the builder toolbar — confirm, delete, and close the panel. */
  | { type: 'deleteWorkflow'; workflowId: string }
  /** User clicked Start — save the spec, then start a governed run (mandatory HITL per agent). */
  | { type: 'startWorkflow'; spec: WorkflowSpec; workflowId: string }
  /** Webview requests a fresh agent list (discovered + foundry). */
  | { type: 'requestAgents' }
  /** User clicked "Duplicate" in the read-only banner. */
  | { type: 'duplicateWorkflow'; workflowId: string }
  /** User wants to create a new workflow from the toolbar (opens the create modal). */
  | { type: 'newWorkflow' }
  /** User confirmed the create-from-agents modal — persist this generated spec and open it. */
  | { type: 'createWorkflow'; spec: WorkflowSpec }
  /** User wants to add a node of the given kind at a position. */
  | { type: 'addNode'; kind: SpecNodeKind; label: string }
  /** Webview requests the current AI assistant preference. */
  | { type: 'getAiPreference' }
  /** User changed their AI assistant preference in the Settings tab. */
  | { type: 'setAiPreference'; assistant: AiAssistant }
  /** User clicked "View full audit log" in the run log drawer. */
  | { type: 'openRunAudit' }
  /** User approved the pending plan on a paused run — execution continues. */
  | { type: 'approveRun'; runId: string; comment?: string }
  /** User rejected the pending plan on a paused run — the whole run halts. */
  | { type: 'rejectRun'; runId: string; comment?: string }
  /** Project workflow: map an agent step to another agent (null = no agent). */
  | { type: 'setStepAgent'; nodeId: string; agentSlug: string | null }
  /** Project workflow: pin an agent step to a harness (null = the harness the run starts with). */
  | { type: 'setStepHarness'; nodeId: string; harness: string | null }
  /** Project workflow: start it on a story in the selected harness. */
  | { type: 'startPlatformWorkflow' }
  /** Project workflow: show an agent's instructions. */
  | { type: 'openPlatformAgent'; slug: string }
  /** Project workflow: re-fetch the workflow and the project's agents. */
  | { type: 'refreshPlatform' }
  /** Open a project workflow (from a local workflow's "Edit agent mapping" link). */
  | { type: 'openPlatformWorkflow'; projectKey: string; workflowId: string }
  /** Open the project workflow in the web app. */
  | { type: 'openPlatformInBrowser' }
