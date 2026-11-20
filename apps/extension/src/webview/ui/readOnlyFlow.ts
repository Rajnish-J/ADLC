// React Flow nodes/edges for a read-only canvas (a workflow being viewed or run, or a project workflow): the
// shared specToFlow layout, locked, with an optional run overlay. Used by the view-mode canvas (App.tsx) and the
// project workflow view (PlatformWorkflowView.tsx).

import type { Edge } from '@xyflow/react'
import type { WorkflowSpec } from '../../runtime/spec'
import { specToFlow, type NodeOverlay } from '../../runtime/canvas/specToFlow'
import type { GovNode, GovNodeData } from './nodes/BaseNode'

export function buildNodes(spec: WorkflowSpec, overlay: Record<string, NodeOverlay>): GovNode[] {
  return specToFlow(spec).nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    draggable: false,
    connectable: false,
    deletable: false,
    data: { ...n.data, overlay: overlay[n.id] } as GovNodeData,
  }))
}

export function buildEdges(spec: WorkflowSpec, overlay: Record<string, NodeOverlay>): Edge[] {
  return specToFlow(spec).edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: overlay[e.source]?.status === 'running',
  }))
}
