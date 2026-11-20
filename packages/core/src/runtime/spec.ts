// Phase 4 — the WorkflowSpec IR.
//
// The version-controllable intermediate representation a discovered agent set compiles to. It is the single
// source of truth both runtimes consume: the MockWorkflowRuntime interprets it in-process (now), and the
// FoundryWorkflowRuntime compiles it to declarative YAML (later, see specToYaml). Deliberately framework-free
// (no `vscode`, no SDK types) so it round-trips to `.sdlc/workflows/*.json` and is exhaustively unit-testable.

import type { SdlcStep } from '../eval/sdlcSteps'

/** The orchestration patterns Phase 4 MVP ships. Concurrent / group-chat are deferred (see plan §P4.5). */
export type WorkflowPattern = 'sequential' | 'handoff'

/**
 * A spec node. Mirrors the orka node taxonomy but trimmed to what the MVP needs. `kind` drives both the
 * in-process interpreter and the declarative-YAML emitter.
 */
export type SpecNodeKind =
  | 'trigger'
  | 'agent'
  | 'gate'
  | 'approval'
  | 'condition'
  | 'set-variable'
  | 'goto'
  | 'end'

export interface SpecNode {
  /** Stable, human-meaningful id — becomes the declarative action `id`. */
  id: string
  kind: SpecNodeKind
  label: string
  /** Kind-specific payload; shape documented per kind below. */
  data: SpecNodeData
  /** Persisted canvas position (top-left). Absent on legacy specs → auto-laid-out on load. */
  position?: { x: number; y: number }
}

/** Where an issue trigger fetches work items from. Azure DevOps Boards is the only source the MVP ships. */
export type IssueSource = 'azure-devops'

/** Union of the per-kind payloads. Optional fields are populated only for the relevant kind. */
export interface SpecNodeData {
  // trigger
  /**
   * How a run is seeded. `manual` (default) takes a free-text task; `issue` fetches the user's
   * assigned work items from `issueSource` and seeds the run from the picked item.
   */
  triggerType?: 'manual' | 'issue'
  /** The backlog the issue trigger reads from (only `azure-devops` for now). */
  issueSource?: IssueSource
  /** Azure DevOps organization (the `dev.azure.com/<org>` segment). Falls back to the setting. */
  adoOrg?: string
  /** Azure DevOps project name. Falls back to the setting. */
  adoProject?: string
  /** Work-item type to list (defaults to `User Story`). */
  workItemType?: string
  /** Optional WIQL override; when set, takes precedence over the assigned-to-@Me default query. */
  wiql?: string

  // agent
  /** InternalAgent.id this node runs (resolved to a Foundry agent name+version at registration). */
  agentId?: string
  /** Agent name as registered in Foundry (`InvokeAzureAgent.agent.name`). */
  agentName?: string
  /** Catalog skills (slugs) the agent may use in this step; materialized for the harness that runs it. */
  skills?: string[]
  /** SDLC step this agent's output is gated at. */
  sdlcStep?: SdlcStep
  /** Variable the agent response is captured into (e.g. `Local.DesignerResult`). */
  outputVar?: string
  /**
   * The harness (`claude-code`, `copilot`, `codex`, …) this agent step runs in. Unset = the harness the run was
   * started with. Platform runs honour it (each step goes to its own harness); local runs ignore it.
   */
  harness?: string
  /**
   * Whether the agent first submits a plan that a person approves before it executes (platform runs). Defaults to
   * true; `false` hands the step straight out to execute.
   */
  requirePlanApproval?: boolean

  // gate
  /** SDLC step whose policy the gate enforces (defaults to the preceding agent's step). */
  gateStep?: SdlcStep
  /** Variable the gate result object lands in (e.g. `Local.GateResult`). */
  gateResultVar?: string

  // approval
  /** Prompt shown to the human approver. */
  question?: string
  /** Variable the approval answer lands in (e.g. `Local.Approval`). */
  approvalVar?: string
  /** The answer suggested to the approver. */
  approvalDefault?: string

  // condition
  /** PowerFx-ish predicate (orka `evaluateCondition` dialect), e.g. `=Not(Local.GateResult.pass)`. */
  predicate?: string
  /** IF / ELSE_IF / ELSE — drives precedence in a condition switch. */
  branch?: 'IF' | 'ELSE_IF' | 'ELSE'

  // set-variable
  variable?: string
  value?: string

  // goto
  /** Target node id (declarative `GotoAction.actionId`). */
  targetId?: string
}

export interface SpecEdge {
  source: string
  target: string
}

/** Per-run safety budget. Mirrors orka's RunGuards; enforced by the ported GuardState. */
export interface RunBudget {
  /** Hard ceiling on node executions — stops unbounded goto loops. */
  maxSteps: number
  /** Wall-clock ceiling in ms. */
  timeoutMs: number
  /** Optional token ceiling across agent steps (0 / undefined = unbounded). */
  maxTokens?: number
}

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxSteps: 50,
  timeoutMs: 5 * 60_000,
  maxTokens: 0,
}

/** The compiled workflow. Persisted as JSON; compiled to declarative YAML by specToYaml. */
export interface WorkflowSpec {
  /** Schema version of the IR itself, so persisted specs can migrate. */
  specVersion: 1
  /** Workflow name (becomes the Foundry workflow-agent name). */
  name: string
  description: string
  pattern: WorkflowPattern
  nodes: SpecNode[]
  edges: SpecEdge[]
  budget: RunBudget
}
