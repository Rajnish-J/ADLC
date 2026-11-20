// Phase 5A — auto-layout. Ported from the orka canvas (claude-code-analytics
// src/lib/orka/workflow-layout.ts): Dagre, left-to-right, fixed node box. Kept generic (operates on
// plain {id}+{source,target} shapes, no @xyflow/react and no WorkflowSpec coupling) so it is pure,
// unit-testable under the Node test config, and reusable by specToFlow. See plan §3.5 Harvest map.

import dagre from '@dagrejs/dagre'

/** The orka node box — matches the rendered custom-node footprint closely enough for clean routing. */
export const NODE_WIDTH = 180
export const NODE_HEIGHT = 64

export interface LayoutInput {
  nodes: { id: string }[]
  edges: { source: string; target: string }[]
}

/** Top-left position for each node id (React Flow positions nodes by their top-left corner). */
export type Positions = Map<string, { x: number; y: number }>

/**
 * Hierarchical left-to-right layout. Dagre returns node centers; we convert to the top-left origin
 * React Flow expects. Nodes/edges referencing unknown ids are skipped defensively.
 */
export function layoutWorkflow(input: LayoutInput): Positions {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 60 })

  const ids = new Set(input.nodes.map((n) => n.id))
  for (const n of input.nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const e of input.edges) {
    if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target)
  }

  dagre.layout(g)

  const positions: Positions = new Map()
  for (const n of input.nodes) {
    const laid = g.node(n.id)
    if (!laid) continue
    positions.set(n.id, { x: laid.x - NODE_WIDTH / 2, y: laid.y - NODE_HEIGHT / 2 })
  }
  return positions
}
