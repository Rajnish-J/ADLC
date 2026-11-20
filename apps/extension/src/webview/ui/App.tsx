// Root webview component. Switches between:
//   • Read-only canvas (Phase 5A) — triggered by 'render' messages, streams live run overlays.
//   • Full builder (Phase 5B) — triggered by 'renderBuilder' messages, full authoring + YAML/Code views.
//
// State persisted to webview store so a reload re-renders without a host round-trip.

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from '@xyflow/react'
import type { WorkflowSpec } from '../../runtime/spec'
import type { RunState } from '../../runtime/port'
import type { AgentSummary, HarnessOption, HostToWebview, PlatformWorkflowLink, PlatformWorkflowView as PlatformView } from '../messages'
import { runStateToOverlay } from '../../runtime/canvas/specToFlow'
import { nodeTypes } from './nodes'
import type { GovNode } from './nodes/BaseNode'
import { buildEdges, buildNodes } from './readOnlyFlow'
import { PlatformWorkflowView } from './PlatformWorkflowView'
import { onHostMessage, vscode, type PersistedState } from './vscodeApi'
import { BuilderShell } from './BuilderShell'
import { RunLogPanel } from './RunLogPanel'
import { NodeIntrospectionCard } from './NodeIntrospectionCard'

// ── Read-only canvas (Phase 5A) ───────────────────────────────────────────────

function ReadOnlyCanvas(): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<GovNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [runState, setRunState] = useState<RunState | undefined>(undefined)
  const [showLog, setShowLog] = useState(true)
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined)
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const specRef = useRef<WorkflowSpec | undefined>(undefined)

  const renderSpec = useCallback(
    (spec: WorkflowSpec, runState?: RunState, agents?: AgentSummary[]) => {
      specRef.current = spec
      const overlay = runState ? runStateToOverlay(runState) : {}
      setNodes(buildNodes(spec, overlay))
      setEdges(buildEdges(spec, overlay))
      setRunState(runState)
      if (agents) setAgents(agents)
      vscode.setState({ mode: 'view', spec, runState, agents })
    },
    [setNodes, setEdges],
  )

  const applyOverlay = useCallback(
    (runState: RunState) => {
      const overlay = runStateToOverlay(runState)
      setNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, overlay: overlay[n.id] } })))
      setEdges((prev) => prev.map((e) => ({ ...e, animated: overlay[e.source]?.status === 'running' })))
      setRunState(runState)
      if (specRef.current) vscode.setState({ mode: 'view', spec: specRef.current, runState })
    },
    [setNodes, setEdges],
  )

  useEffect(() => {
    const persisted = vscode.getState() as PersistedState | undefined
    if (persisted?.mode === 'view' && persisted.spec) renderSpec(persisted.spec, persisted.runState, persisted.agents)

    const off = onHostMessage((msg) => {
      if (msg.type === 'render') renderSpec(msg.spec, msg.runState, msg.agents)
      else if (msg.type === 'runUpdate') applyOverlay(msg.runState)
      else if (msg.type === 'agentsLoaded') setAgents(msg.agents)
    })
    vscode.postMessage({ type: 'ready' })
    return off
  }, [renderSpec, applyOverlay])

  // A freshly-started run should surface the drawer even if the user hid it for a previous run.
  useEffect(() => {
    if (runState?.status === 'running' && runState.steps.length <= 1) setShowLog(true)
  }, [runState?.runId])

  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    vscode.postMessage({ type: 'revealNode', nodeId: node.id })
    setSelectedNodeId((prev) => (prev === node.id ? undefined : node.id))
  }, [])

  const selectedSpecNode = selectedNodeId ? specRef.current?.nodes.find((n) => n.id === selectedNodeId) : undefined
  const selectedOverlay = runState && selectedNodeId ? runStateToOverlay(runState)[selectedNodeId] : undefined
  const selectedAgent = selectedSpecNode?.data.agentId
    ? agents.find((a) => a.id === selectedSpecNode.data.agentId)
    : undefined

  return (
    <div className="canvas-shell">
      <div className="canvas-shell__flow">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
        {runState && !showLog && (
          <button className="run-log__reopen-btn" onClick={() => setShowLog(true)}>
            Show run log
          </button>
        )}
        {selectedSpecNode?.kind === 'agent' && (
          <NodeIntrospectionCard
            nodeId={selectedSpecNode.id}
            label={selectedSpecNode.label}
            overlay={selectedOverlay}
            agent={selectedAgent}
            onClose={() => setSelectedNodeId(undefined)}
          />
        )}
      </div>
      {runState && showLog && <RunLogPanel runState={runState} onClose={() => setShowLog(false)} />}
    </div>
  )
}

// ── Root dispatcher ───────────────────────────────────────────────────────────

interface BuilderState {
  spec: WorkflowSpec
  isReadOnly: boolean
  workflowId: string
  agents: AgentSummary[]
  createMode?: boolean
  platformLink?: PlatformWorkflowLink
  harnesses?: HarnessOption[]
}

export function App(): JSX.Element {
  const [builderState, setBuilderState] = useState<BuilderState | null>(null)
  const [platformView, setPlatformView] = useState<PlatformView | null>(null)

  useEffect(() => {
    const persisted = vscode.getState() as { mode?: string; builderState?: BuilderState; platformView?: PlatformView } | undefined
    if (persisted?.mode === 'builder' && persisted.builderState) {
      setBuilderState(persisted.builderState)
    } else if (persisted?.mode === 'platform' && persisted.platformView) {
      setPlatformView(persisted.platformView)
    }

    const off = onHostMessage((msg: HostToWebview) => {
      if (msg.type === 'renderBuilder') {
        const state: BuilderState = {
          spec: msg.spec,
          isReadOnly: msg.isReadOnly,
          workflowId: msg.workflowId,
          agents: msg.agents,
          createMode: msg.createMode,
          platformLink: msg.platformLink,
          harnesses: msg.harnesses,
        }
        setPlatformView(null)
        setBuilderState(state)
        vscode.setState({ mode: 'builder', builderState: state })
      } else if (msg.type === 'renderPlatform') {
        setBuilderState(null)
        setPlatformView(msg.view)
        vscode.setState({ mode: 'platform', platformView: msg.view })
      } else if (msg.type === 'render') {
        // Leaving a project workflow for a plain canvas (e.g. a run): the view canvas mounts after this message,
        // so hand it the spec through the persisted state it restores from. (The builder handles 'render' itself.)
        setPlatformView((prev) => {
          if (prev) vscode.setState({ mode: 'view', spec: msg.spec, runState: msg.runState, agents: msg.agents })
          return null
        })
      } else if (msg.type === 'agentsLoaded') {
        setBuilderState((prev) => (prev ? { ...prev, agents: msg.agents } : prev))
      }
    })

    vscode.postMessage({ type: 'ready' })
    return off
  }, [])

  if (platformView) {
    return <PlatformWorkflowView view={platformView} />
  }
  if (builderState) {
    return <BuilderShell {...builderState} />
  }

  return (
    <ReactFlowProvider>
      <ReadOnlyCanvas />
    </ReactFlowProvider>
  )
}
