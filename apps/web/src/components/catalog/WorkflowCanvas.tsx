'use client'

// Read-only workflow canvas: the same specToFlow + Dagre layout the VS Code canvas uses (@sdlc/core), drawn
// with React Flow, themed with the app's tokens and following the light / dark theme. On a run's page it also shows
// each step's live status and keeps the current step in view (until you pan away).

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useTheme } from 'next-themes'
import { Background, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Crosshair } from 'lucide-react'
import { specToFlow, type FlowNodeData, type RunMapStatus, type WorkflowSpec } from '@sdlc/core'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { KIND_STYLE, WorkflowNodeCard } from './WorkflowNodeCard'

export { KIND_STYLE }

/** Flow data plus the harness an agent step is pinned to (from the spec; specToFlow does not carry it). */
type CanvasNode = Node<FlowNodeData & { harness?: string; status?: RunMapStatus } & Record<string, unknown>>

function WorkflowNode({ data }: NodeProps<CanvasNode>): JSX.Element {
  return <WorkflowNodeCard kind={data.kind} label={data.label} subtitle={data.subtitle} agentId={data.agentId} harness={data.harness} status={data.status} />
}

const nodeTypes = Object.fromEntries(Object.keys(KIND_STYLE).map((k) => [k, WorkflowNode]))

export interface WorkflowCanvasProps {
  spec: WorkflowSpec
  /** A run's live status per node id (the run page); omitted on the workflow page. */
  status?: Record<string, RunMapStatus>
  /** The node a run is on: the view follows it until the user pans away. */
  focusNodeId?: string | null
  /** Sizing; defaults to the workflow page's height. */
  className?: string
}

export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

function Canvas({ spec, status, focusNodeId, className }: WorkflowCanvasProps) {
  const { resolvedTheme } = useTheme()
  const { fitView } = useReactFlow()
  const { nodes, edges, opening } = useMemo(() => {
    const flow = specToFlow(spec)
    const harnessById = new Map(spec.nodes.map((n) => [n.id, n.data.harness]))
    // Long left-to-right pipelines become unreadable when fitted whole; open on the first steps at a legible
    // zoom and let people pan (scroll / drag / minimap) along the rest.
    const opening = [...flow.nodes]
      .sort((a, b) => a.position.x - b.position.x)
      .slice(0, 4)
      .map((n) => ({ id: n.id }))
    const nodes = flow.nodes.map((n) => ({ ...n, data: { ...n.data, harness: harnessById.get(n.id), status: status?.[n.id] } })) as CanvasNode[]
    const live = (id: string) => status?.[id] === 'running' || status?.[id] === 'waiting'
    return { nodes, edges: flow.edges.map((e) => ({ ...e, type: 'smoothstep', animated: live(e.target) })), opening }
  }, [spec, status])

  // The current step and its neighbours, so the view shows where the run came from and goes next.
  const focus = useMemo(() => {
    if (!focusNodeId) return null
    const ids = new Set([focusNodeId])
    for (const e of edges) {
      if (e.source === focusNodeId) ids.add(e.target)
      if (e.target === focusNodeId) ids.add(e.source)
    }
    return [...ids].map((id) => ({ id }))
  }, [edges, focusNodeId])

  const [following, setFollowing] = useState(true)
  const followRef = useRef(following)
  followRef.current = following
  const recenter = useCallback(() => {
    if (focus) void fitView({ nodes: focus, padding: 0.15, maxZoom: 1, duration: 400 })
  }, [fitView, focus])

  useEffect(() => {
    if (followRef.current) recenter()
  }, [recenter])

  return (
    <div className={cn('workflow-canvas w-full', className ?? 'h-[440px]')}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ nodes: focus ?? opening, padding: 0.15, maxZoom: 1 }}
        // A pan or zoom by the user (it carries an event; our fitView doesn't) stops following the current step.
        onMoveStart={(event) => {
          if (event && focusNodeId) setFollowing(false)
        }}
        panOnScroll
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
        {focus && !following ? (
          <Panel position="top-right">
            <Button
              size="sm"
              variant="secondary"
              className="h-7 shadow-sm"
              onClick={() => {
                setFollowing(true)
                recenter()
              }}
            >
              <Crosshair /> Follow current step
            </Button>
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  )
}
