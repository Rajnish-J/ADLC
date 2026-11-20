// Phase 4 — graph helpers. Ported verbatim from the orka orchestrator (claude-code-analytics
// src/lib/orka/orchestrator/graph.ts). Parses node/edge JSON into an adjacency map the in-process
// interpreter traverses. Pure (no DB, no side effects, no vscode). See plan §3.5 Harvest map.

export interface WorkflowNode {
  id: string
  type?: string
  position?: { x: number; y: number }
  data: Record<string, unknown>
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
}

export interface ParsedGraph {
  nodes: Map<string, WorkflowNode>
  /** node id → outgoing successor nodes, in edge declaration order */
  outgoing: Map<string, WorkflowNode[]>
}

export const CONDITION_PRECEDENCE: Record<string, number> = {
  IF: 0,
  ELSE_IF: 1,
  ELSE: 2,
}

export function parseGraph(nodesRaw: unknown[], edgesRaw: unknown[]): ParsedGraph {
  const nodes = new Map<string, WorkflowNode>()
  for (const raw of nodesRaw) {
    const n = raw as WorkflowNode
    if (n && typeof n.id === 'string') {
      nodes.set(n.id, { ...n, data: (n.data ?? {}) as Record<string, unknown> })
    }
  }

  const outgoing = new Map<string, WorkflowNode[]>()
  for (const raw of edgesRaw) {
    const e = raw as WorkflowEdge
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue
    const targetNode = nodes.get(e.target)
    if (!targetNode) continue
    const list = outgoing.get(e.source) ?? []
    list.push(targetNode)
    outgoing.set(e.source, list)
  }

  return { nodes, outgoing }
}

/**
 * Picks the entry node — the explicit TRIGGER, else the first node with no
 * incoming edge, else the first node declared.
 */
export function findTrigger(graph: ParsedGraph): WorkflowNode | null {
  for (const node of graph.nodes.values()) {
    if (node.type === 'TRIGGER') return node
  }
  const hasIncoming = new Set<string>()
  for (const succs of graph.outgoing.values()) {
    for (const s of succs) hasIncoming.add(s.id)
  }
  for (const node of graph.nodes.values()) {
    if (!hasIncoming.has(node.id) && node.type !== 'NOTE') return node
  }
  return graph.nodes.values().next().value ?? null
}

export function successors(graph: ParsedGraph, nodeId: string): WorkflowNode[] {
  return graph.outgoing.get(nodeId) ?? []
}
