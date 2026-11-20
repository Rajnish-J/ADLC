// Phase 4 — adapts a WorkflowSpec into the orka graph node/edge shape so the in-process interpreter can
// reuse the ported parseGraph / findTrigger / successors / CONDITION_PRECEDENCE unchanged. Pure.

import type { SpecNode, SpecNodeKind, WorkflowSpec } from '../spec'
import type { WorkflowEdge, WorkflowNode } from '../graph'

/** SpecNode.kind → the `type` string the interpreter switches on (matches orka's uppercase convention). */
const KIND_TO_TYPE: Record<SpecNodeKind, string> = {
  trigger: 'TRIGGER',
  agent: 'AGENT',
  gate: 'GATE',
  approval: 'APPROVAL',
  condition: 'CONDITION',
  'set-variable': 'SET_VARIABLE',
  goto: 'GOTO',
  end: 'END',
}

function toNode(n: SpecNode): WorkflowNode {
  return {
    id: n.id,
    type: KIND_TO_TYPE[n.kind],
    // Carry the spec payload plus the label so the interpreter has everything in one bag.
    data: { ...n.data, label: n.label, kind: n.kind },
  }
}

export interface RuntimeGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export function specToGraph(spec: WorkflowSpec): RuntimeGraph {
  return {
    nodes: spec.nodes.map(toNode),
    edges: spec.edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
  }
}
