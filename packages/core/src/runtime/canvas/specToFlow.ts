// Phase 5A — pure mapping from the WorkflowSpec source of truth to the read-only canvas model.
//
// Two pure functions the webview consumes via postMessage:
//   specToFlow(spec)        → laid-out {nodes, edges} for React Flow (positions from Dagre).
//   runStateToOverlay(run)  → per-node execution status + gate/error detail to paint live overlays.
// No `vscode`, no `@xyflow/react` import (FlowNode/FlowEdge are local, structurally compatible with
// React Flow's Node/Edge) so this stays host-side unit-testable. See plan §5A.

import type { RunState, RunStepActivity, RunStepStatus } from '../port'
import type { SpecNodeKind, WorkflowSpec } from '../spec'
import { layoutWorkflow } from '../layout/workflowLayout'
import { nodeSubtitle } from './builderFlow'

/** The data payload each rendered node carries. `type` (= SpecNodeKind) selects the node component. */
export interface FlowNodeData {
  kind: SpecNodeKind
  label: string
  /** One-line secondary text (e.g. SDLC step, target variable, predicate). */
  subtitle?: string
  /** Condition branch precedence, shown on condition nodes. */
  branch?: 'IF' | 'ELSE_IF' | 'ELSE'
  /** InternalAgent.id for agent nodes — used by Evaluate/Govern canvas buttons. */
  agentId?: string
}

export interface FlowNode {
  id: string
  type: SpecNodeKind
  position: { x: number; y: number }
  data: FlowNodeData
}

export interface FlowEdge {
  id: string
  source: string
  target: string
}

export interface FlowModel {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

/** Map a WorkflowSpec into a laid-out, read-only flow model. */
export function specToFlow(spec: WorkflowSpec): FlowModel {
  const positions = layoutWorkflow({ nodes: spec.nodes, edges: spec.edges })
  const nodes: FlowNode[] = spec.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position ?? positions.get(n.id) ?? { x: 0, y: 0 },
    data: { kind: n.kind, label: n.label, subtitle: nodeSubtitle(n), branch: n.data.branch, agentId: n.data.agentId },
  }))
  const edges: FlowEdge[] = spec.edges.map((e, i) => ({
    id: `e${i}_${e.source}_${e.target}`,
    source: e.source,
    target: e.target,
  }))
  return { nodes, edges }
}

/** Truncate long step text for a hover tooltip. */
const TOOLTIP_EXCERPT_LENGTH = 300
function excerpt(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return trimmed.length > TOOLTIP_EXCERPT_LENGTH ? `${trimmed.slice(0, TOOLTIP_EXCERPT_LENGTH)}…` : trimmed
}

/** The live execution detail painted onto one node. */
export interface NodeOverlay {
  status: RunStepStatus
  error?: string
  /** Present on gate nodes — the enforcing decision summary for the tooltip. */
  gate?: { pass: boolean; reason: string }
  /** Present on agent nodes — the plan generated before human approval, truncated for hover. */
  plan?: string
  /** Present on agent nodes once executed — the agent's output, truncated for hover. */
  output?: string
  /** Present on a `running` agent node — live thought/action/token streaming detail for the
   * click-to-expand introspection card. Absent for MockWorkflowRuntime runs. */
  activity?: RunStepActivity
}

/**
 * Reduce a RunState to per-node overlays. A node can execute more than once (goto loops); the LAST
 * step for a node id wins so the canvas reflects current state.
 */
export function runStateToOverlay(run: RunState): Record<string, NodeOverlay> {
  const overlay: Record<string, NodeOverlay> = {}
  for (const step of run.steps) {
    overlay[step.nodeId] = {
      status: step.status,
      error: step.error,
      gate: step.gateDecision
        ? { pass: step.gateDecision.pass, reason: step.gateDecision.reason }
        : undefined,
      plan: excerpt(step.plan),
      output: excerpt(step.output),
      activity: step.status === 'running' ? step.activity : undefined,
    }
  }
  return overlay
}
