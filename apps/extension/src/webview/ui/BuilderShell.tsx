// BuilderShell — the full workflow editor. Wraps the React Flow canvas with a toolbar,
// a NodeDetailPanel sidebar, and YAML/Code view tabs. Handles all authoring interactions
// (drag, connect, add node, delete, save) and posts messages to the extension host.
//
// Activated when the host sends a `renderBuilder` message (vs. the read-only `render`).

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeMouseHandler,
  type OnConnectEnd,
} from '@xyflow/react'
import type { WorkflowSpec, SpecNodeKind } from '../../runtime/spec'
import type { RunState } from '../../runtime/port'
import type { AgentSummary, HarnessOption, PlatformWorkflowLink } from '../messages'
import { onHostMessage, vscode } from './vscodeApi'
import { RunLogPanel } from './RunLogPanel'
import {
  blankNode,
  builderFlowToSpec,
  ensureStartEnd,
  reorderAgents,
  specFromAgents,
  specToBuilderFlow,
  type BuilderNode,
  type BuilderNodeData,
  type WorkflowTrigger,
} from './builderUtils'
import { nodeTypes } from './nodes'
import { BuilderNodeContext } from './builderContext'
import { Toolbar } from './Toolbar'
import { NodePalette } from './NodePalette'
import { NodeDetailPanel } from './NodeDetailPanel'
import { CreateWorkflowModal } from './CreateWorkflowModal'
import { YamlView } from './YamlView'
import { CodeView } from './CodeView'
import { SettingsView } from './SettingsView'
import { layoutWorkflow } from '../../runtime/layout/workflowLayout'

interface Props {
  spec: WorkflowSpec
  isReadOnly: boolean
  workflowId: string
  agents: AgentSummary[]
  createMode?: boolean
  platformLink?: PlatformWorkflowLink
  /** Harnesses an agent step can be pinned to. */
  harnesses?: HarnessOption[]
}

function Builder({ spec, isReadOnly, workflowId, agents: initialAgents, createMode, platformLink, harnesses }: Props): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<BuilderNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNode, setSelectedNode] = useState<BuilderNode | null>(null)
  const [activeTab, setActiveTab] = useState<'canvas' | 'yaml' | 'code' | 'settings'>('canvas')
  const [agents, setAgents] = useState<AgentSummary[]>(initialAgents)
  const [showCreate, setShowCreate] = useState<boolean>(!!createMode)
  const [runState, setRunState] = useState<RunState | undefined>(undefined)
  const [showLog, setShowLog] = useState(true)
  const specRef = useRef<WorkflowSpec>(spec)
  // Auto-save gating: the first nodes/edges change after a spec load is not a user edit, so skip it.
  const skipAutoSaveRef = useRef(true)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { screenToFlowPosition } = useReactFlow()

  // Populate canvas from incoming spec
  useEffect(() => {
    specRef.current = spec
    skipAutoSaveRef.current = true
    const { nodes: rawNodes, edges: rawEdges } = specToBuilderFlow(spec)

    // Respect saved positions; only Dagre-layout when the spec has none (legacy / freshly generated).
    const savedPos = new Map(spec.nodes.filter((sn) => sn.position).map((sn) => [sn.id, sn.position!]))
    const laidOut = savedPos.size === spec.nodes.length
      ? rawNodes
      : (() => {
          const positions = layoutWorkflow({ nodes: rawNodes, edges: rawEdges })
          return rawNodes.map((node) => ({
            ...node,
            position: savedPos.get(node.id) ?? positions.get(node.id) ?? node.position,
          }))
        })()
    // Guarantee Start/End always exist, even for hand-edited or legacy specs missing them.
    const { nodes: n, edges: e } = ensureStartEnd(laidOut, rawEdges)
    setNodes(n)
    setEdges(e)
    setSelectedNode(null)
  }, [spec, setNodes, setEdges])

  // ── Auto-save: persist edits/deletes to disk (debounced), no manual Save needed ──
  useEffect(() => {
    if (isReadOnly || createMode || workflowId === '__new__') return
    if (skipAutoSaveRef.current) {
      skipAutoSaveRef.current = false
      return
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const updatedSpec = builderFlowToSpec(nodes, edges, specRef.current)
      specRef.current = updatedSpec
      vscode.postMessage({ type: 'saveWorkflow', spec: updatedSpec, workflowId, silent: true })
    }, 600)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [nodes, edges, isReadOnly, createMode, workflowId])

  // Sync agent list from host
  useEffect(() => {
    setAgents(initialAgents)
  }, [initialAgents])

  // Live run state: the host posts 'render' once a run starts/finishes and 'runUpdate' as it
  // progresses (see workflowCanvasPanel.ts). Surfacing this here — not just in the read-only
  // canvas — is what makes clicking ▶ Start actually show something while editing.
  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.type === 'render' && msg.runState) setRunState(msg.runState)
      else if (msg.type === 'runUpdate') setRunState(msg.runState)
    })
  }, [])

  // A freshly-started run should surface the drawer even if the user hid it for a previous run.
  useEffect(() => {
    if (runState?.status === 'running' && runState.steps.length <= 1) setShowLog(true)
  }, [runState?.runId])

  // ── Keyboard: delete selected node ──────────────────────────────────────────
  useEffect(() => {
    if (isReadOnly) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return
      // Start/End are structural — never removable, even when selected alongside other nodes.
      setNodes((prev) => prev.filter((n) => !n.selected || n.data.kind === 'trigger' || n.data.kind === 'end'))
      setEdges((prev) => prev.filter((ed) => !ed.selected))
      setSelectedNode((prev) => (prev?.selected ? null : prev))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isReadOnly, setNodes, setEdges])

  // ── Handlers ────────────────────────────────────────────────────────────────

  const onConnect = useCallback(
    (connection: Connection) => {
      if (isReadOnly) return
      setEdges((eds) => addEdge(connection, eds))
    },
    [isReadOnly, setEdges],
  )

  // @ts-expect-error — ReactFlow types differ slightly but runtime call is fine
  const onConnectEnd: OnConnectEnd = useCallback(
    (_e: MouseEvent, connectionState: { isValid: boolean }) => {
      if (!connectionState.isValid || isReadOnly) return
    },
    [isReadOnly],
  )

  const onNodeClick: NodeMouseHandler<BuilderNode> = useCallback(
    (_e, node) => {
      setSelectedNode(node)
    },
    [],
  )

  const onPaneClick = useCallback(() => {
    setSelectedNode(null)
  }, [])

  // ── Drag-from-palette drop handlers ────────────────────────────────────────

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const kind = e.dataTransfer.getData('application/reactflow-node-kind') as SpecNodeKind
      if (!kind) return
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const newNode = blankNode(kind, position)
      setNodes((prev) => [...prev, newNode])
      setSelectedNode(newNode)
    },
    [screenToFlowPosition, setNodes],
  )

  const handleAutoLayout = useCallback(() => {
    setNodes((prev) => {
      const positions = layoutWorkflow({ nodes: prev, edges })
      return prev.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position }))
    })
  }, [edges, setNodes])

  const handleNodeUpdate = useCallback(
    (id: string, patch: Partial<BuilderNodeData>) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
        ),
      )
      setSelectedNode((prev) =>
        prev?.id === id ? { ...prev, data: { ...prev.data, ...patch } } : prev,
      )
    },
    [setNodes],
  )

  const handleNodeDelete = useCallback(
    (id: string) => {
      setNodes((prev) => {
        const target = prev.find((n) => n.id === id)
        // Start/End are structural — the workflow must always have both.
        if (target && (target.data.kind === 'trigger' || target.data.kind === 'end')) return prev
        return prev.filter((n) => n.id !== id)
      })
      setEdges((prev) => prev.filter((ed) => ed.source !== id && ed.target !== id))
      setSelectedNode((prev) => (prev?.id === id ? null : prev))
    },
    [setNodes, setEdges],
  )

  // Reorder a node's place in the linear execution chain by rewiring its edges.
  // `pred → node → succ` (with pred's inbound `pp → pred`) becomes `pp → node → pred → succ`
  // when moving earlier; the mirror when moving later. Positions swap so the picture follows.
  const handleNodeReorder = useCallback(
    (id: string, dir: 'earlier' | 'later') => {
      const inbound = edges.find((e) => e.target === id)
      const outbound = edges.find((e) => e.source === id)
      if (!inbound || !outbound) return
      const pred = inbound.source
      const succ = outbound.target
      const neighbor = dir === 'earlier' ? pred : succ

      const next = edges.map((e) => ({ ...e }))
      const nInbound = next.find((e) => e.target === id)!
      const nOutbound = next.find((e) => e.source === id)!
      if (dir === 'earlier') {
        const predInbound = next.find((e) => e.target === pred)
        if (predInbound) predInbound.target = id // pp → node
        nInbound.source = id
        nInbound.target = pred // node → pred
        nOutbound.source = pred // pred → succ
      } else {
        const succOutbound = next.find((e) => e.source === succ)
        if (succOutbound) succOutbound.source = id // node → ss
        nOutbound.source = succ
        nOutbound.target = id // succ → node
        nInbound.target = succ // pred → succ
      }
      setEdges(next)
      setNodes((prev) => {
        const a = prev.find((p) => p.id === id)
        const b = prev.find((p) => p.id === neighbor)
        if (!a || !b) return prev
        return prev.map((p) =>
          p.id === id ? { ...p, position: b.position } : p.id === neighbor ? { ...p, position: a.position } : p,
        )
      })
    },
    [edges, setEdges, setNodes],
  )

  // Settings-tab "Agent Execution Order" — reorder agent nodes across the whole chain at once.
  const handleReorderAgents = useCallback(
    (newAgentOrder: string[]) => {
      setEdges((prev) => reorderAgents(nodes, prev, newAgentOrder))
    },
    [nodes, setEdges],
  )

  const handleSave = useCallback(() => {
    const updatedSpec = builderFlowToSpec(nodes, edges, specRef.current)
    specRef.current = updatedSpec
    vscode.postMessage({ type: 'saveWorkflow', spec: updatedSpec, workflowId, silent: false })
  }, [nodes, edges, workflowId])

  const handleDeleteWorkflow = useCallback(() => {
    vscode.postMessage({ type: 'deleteWorkflow', workflowId })
  }, [workflowId])

  const handleDuplicate = useCallback(() => {
    vscode.postMessage({ type: 'duplicateWorkflow', workflowId })
  }, [workflowId])

  const handleStart = useCallback(() => {
    const updatedSpec = builderFlowToSpec(nodes, edges, specRef.current)
    specRef.current = updatedSpec
    vscode.postMessage({ type: 'startWorkflow', spec: updatedSpec, workflowId })
  }, [nodes, edges, workflowId])

  const handleNew = useCallback(() => {
    setShowCreate(true)
  }, [])

  const handleCreate = useCallback((name: string, selected: AgentSummary[], trigger: WorkflowTrigger) => {
    setShowCreate(false)
    vscode.postMessage({ type: 'createWorkflow', spec: specFromAgents(name, selected, trigger) })
  }, [])

  const currentSpec = useCallback(() => builderFlowToSpec(nodes, edges, specRef.current), [nodes, edges])

  return (
    <div className="builder-shell">
      <Toolbar
        isReadOnly={isReadOnly}
        workflowName={spec.name}
        onAutoLayout={handleAutoLayout}
        onSave={handleSave}
        onDuplicate={handleDuplicate}
        onStart={handleStart}
        onNew={handleNew}
        onDelete={handleDeleteWorkflow}
        canDelete={!createMode && workflowId !== '__new__'}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        platformLink={platformLink}
        onOpenPlatform={
          platformLink
            ? () => vscode.postMessage({ type: 'openPlatformWorkflow', projectKey: platformLink.projectKey, workflowId: platformLink.workflowId })
            : undefined
        }
      />

      <div className="builder-shell__body">
        {/* Canvas tab — 3-column: palette | canvas | detail panel */}
        {activeTab === 'canvas' && (
          <>
            <NodePalette isReadOnly={isReadOnly} />

            <div className="canvas-shell">
              <div
                className="builder-shell__canvas-wrap canvas-shell__flow"
                onDrop={isReadOnly ? undefined : onDrop}
                onDragOver={isReadOnly ? undefined : onDragOver}
              >
                <BuilderNodeContext.Provider value={{ editable: !isReadOnly, onDeleteNode: handleNodeDelete }}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={isReadOnly ? undefined : onNodesChange}
                  onEdgesChange={isReadOnly ? undefined : onEdgesChange}
                  onConnect={isReadOnly ? undefined : onConnect}
                  onConnectEnd={isReadOnly ? undefined : onConnectEnd}
                  onNodeClick={onNodeClick}
                  onPaneClick={onPaneClick}
                  nodesDraggable={!isReadOnly}
                  nodesConnectable={!isReadOnly}
                  elementsSelectable
                  deleteKeyCode={isReadOnly ? null : 'Delete'}
                  fitView
                  proOptions={{ hideAttribution: true }}
                >
                  <Background />
                  <Controls showInteractive={!isReadOnly} />
                </ReactFlow>
                </BuilderNodeContext.Provider>
                {runState && !showLog && (
                  <button className="run-log__reopen-btn" onClick={() => setShowLog(true)}>
                    Show run log
                  </button>
                )}
              </div>
              {runState && showLog && <RunLogPanel runState={runState} onClose={() => setShowLog(false)} />}
            </div>

            {selectedNode && (
              <NodeDetailPanel
                node={selectedNode}
                nodes={nodes}
                edges={edges}
                agents={agents}
                harnesses={harnesses}
                isReadOnly={isReadOnly}
                onUpdate={handleNodeUpdate}
                onDelete={handleNodeDelete}
                onReorder={handleNodeReorder}
                onClose={() => setSelectedNode(null)}
              />
            )}
          </>
        )}

        {/* YAML tab */}
        {activeTab === 'yaml' && <YamlView spec={currentSpec()} />}

        {/* Code tab */}
        {activeTab === 'code' && <CodeView spec={currentSpec()} />}

        {/* Settings tab */}
        {activeTab === 'settings' && (
          <SettingsView
            nodes={nodes}
            edges={edges}
            isReadOnly={isReadOnly}
            onReorderAgents={handleReorderAgents}
          />
        )}
      </div>

      {showCreate && (
        <CreateWorkflowModal
          agents={agents}
          onCreate={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}

export function BuilderShell(props: Props): JSX.Element {
  return (
    <ReactFlowProvider>
      <Builder {...props} />
    </ReactFlowProvider>
  )
}
