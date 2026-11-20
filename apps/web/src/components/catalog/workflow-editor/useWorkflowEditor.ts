'use client'

// The workflow editor's state: the canvas nodes and edges (React Flow), the workflow's name, description and
// budget, what was last saved, live validation, and every editing action — add a step (dropped, or clicked in
// the palette and spliced into the chain), change it, connect, delete (bridging the gap in a chain), auto-layout,
// and save (create, or PATCH with the version the edit started from; 409 when someone saved in between).
// Must be used inside a ReactFlowProvider.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MarkerType, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge } from '@xyflow/react'
import type { Agent } from '@sdlc/contracts'
import {
  blankNode,
  builderFlowToSpec,
  DEFAULT_NODE_LABELS,
  canConnect,
  deletableNodeIds,
  edgeId,
  ensureStartEnd,
  layoutWorkflow,
  NODE_GAP_X,
  NODE_WIDTH,
  removeNodes,
  specToBuilderFlow,
  spliceEdges,
  validateWorkflowSpec,
  type SpecNodeData,
  type SpecNodeKind,
  type WorkflowSpec,
} from '@sdlc/core'
import { toast } from 'sonner'
import { AppError } from '@/appError'
import { createWorkflow, getWorkflow, updateWorkflow } from '@/service/catalog.service'
import type { WorkflowDetail } from '@/types/workflow/workflow.types'
import { stableStringify, stepIssues, type EditorEdge, type EditorNode, type PalettePayload } from './editorModel'

/** Where the editor starts from: a saved workflow, or (id null) a new one not created yet. */
export interface EditorSource {
  id: string | null
  name: string
  description: string
  version: number
  isDefault: boolean
  spec: WorkflowSpec
}

export const toEditorEdge = (e: { id: string; source: string; target: string } & Partial<Edge>): EditorEdge => ({
  ...e,
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
})

const STEP = NODE_WIDTH + NODE_GAP_X

interface Options {
  projectKey: string
  source: EditorSource
  /** The project's agents and skills (null while loading). */
  catalog: Agent[] | null
  allowedHarnesses: readonly string[]
  /** A new workflow was created (the page moves to its edit URL), or an existing one saved. */
  onSaved: (saved: WorkflowDetail, created: boolean) => void
}

export function useWorkflowEditor({ projectKey, source, catalog, allowedHarnesses, onSaved }: Options) {
  const { fitView } = useReactFlow()

  // The canvas as loaded. Fixed for this editor's lifetime — Discard / Reload remount the editor.
  const [initial] = useState(() => {
    const flow = specToBuilderFlow(source.spec)
    const { nodes, edges } = ensureStartEnd(flow.nodes, flow.edges)
    const loaded = builderFlowToSpec(nodes, edges, source.spec, { name: source.name, description: source.description })
    return { nodes: nodes as EditorNode[], edges: edges.map(toEditorEdge), baseline: stableStringify(loaded) }
  })

  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>(initial.edges)
  const [name, setName] = useState(source.name)
  const [description, setDescription] = useState(source.description)
  const [base, setBase] = useState<WorkflowSpec>(source.spec)
  const [setAsDefault, setSetAsDefault] = useState(false)
  const [saved, setSaved] = useState({ version: source.version, baseline: initial.baseline })
  const [saving, setSaving] = useState(false)
  /** The server refused the save because the workflow changed since it was loaded. */
  const [conflict, setConflict] = useState(false)

  const isNew = source.id === null
  const spec = useMemo(
    () => builderFlowToSpec(nodes, edges, base, { name: name.trim(), description: description.trim() }),
    [nodes, edges, base, name, description],
  )
  const dirty = isNew || stableStringify(spec) !== saved.baseline

  // Whole-workflow checks. Messages about one step (unreachable, unnamed, no agent, goto without a target) are
  // left out: stepIssues reports those against the step itself, so they show on its node and can be clicked.
  const validation = useMemo(() => {
    const v = validateWorkflowSpec(spec)
    return {
      errors: v.errors.filter((m) => !/^Not reachable from the trigger:|^Step ".*" has no label\.$|jumps to a missing step\.$/.test(m)),
      warnings: v.warnings.filter((m) => !m.endsWith('has no agent mapped yet.')),
    }
  }, [spec])
  const issues = useMemo(() => stepIssues(spec, catalog, allowedHarnesses), [spec, catalog, allowedHarnesses])
  const errorCount = validation.errors.length + issues.filter((i) => i.level === 'error').length
  const warningCount = validation.warnings.length + issues.filter((i) => i.level === 'warning').length

  const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes])
  const selectedEdges = useMemo(() => edges.filter((e) => e.selected), [edges])

  // ─── Selection ──────────────────────────────────────────────────────────────────────────────────

  const selectStep = useCallback(
    (id: string | null, focus = false) => {
      setNodes((ns) => ns.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })))
      setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)))
      if (id && focus) requestAnimationFrame(() => void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.1 }))
    },
    [setNodes, setEdges, fitView],
  )

  // ─── Adding steps ───────────────────────────────────────────────────────────────────────────────

  const presetFor = useCallback(
    (payload: PalettePayload): { label?: string; idBase?: string; data?: SpecNodeData } => {
      if (payload.kind !== 'agent' || !payload.agentSlug) return {}
      const agent = catalog?.find((a) => a.slug === payload.agentSlug)
      const agentName = agent?.name ?? payload.agentSlug
      return { label: agentName, idBase: payload.agentSlug, data: { agentId: payload.agentSlug, agentName } }
    },
    [catalog],
  )

  /** A step dropped on the canvas at `position` (flow coordinates). It isn't connected yet. */
  const dropStep = useCallback(
    (payload: PalettePayload, position: { x: number; y: number }) => {
      const node = blankNode(payload.kind, position, nodes.map((n) => n.id), presetFor(payload)) as EditorNode
      setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), { ...node, selected: true }])
    },
    [nodes, presetFor, setNodes],
  )

  /**
   * A step clicked in the palette: spliced into the chain after the selected step (before it, when that is an
   * end), or before the end when nothing is selected, pushing the steps to its right along to make room.
   */
  const insertStep = useCallback(
    (payload: PalettePayload) => {
      const ends = nodes.filter((n) => n.data.kind === 'end')
      const anchor = selectedNodes.length === 1 ? selectedNodes[0] : ends.length === 1 ? ends[0] : null
      const preset = presetFor(payload)
      const ids = nodes.map((n) => n.id)
      if (!anchor) {
        const right = nodes.reduce((m, n) => Math.max(m, n.position.x), 0)
        dropStep(payload, { x: right + STEP, y: 0 })
        return
      }
      const mode = anchor.data.kind === 'end' ? 'before' : 'after'
      const at = mode === 'before' ? anchor.position : { x: anchor.position.x + STEP, y: anchor.position.y }
      const node = blankNode(payload.kind, at, ids, preset) as EditorNode
      // Splicing only makes sense for a step that can have both an incoming and an outgoing connection.
      const splice = payload.kind !== 'end' && !(mode === 'after' && anchor.data.kind === 'goto')
      setNodes((ns) => [
        ...ns.map((n) => {
          const shifted = n.position.x >= at.x - 1 && n.id !== node.id ? { ...n, position: { x: n.position.x + STEP, y: n.position.y } } : n
          return shifted.selected ? { ...shifted, selected: false } : shifted
        }),
        { ...node, selected: true },
      ])
      if (splice) setEdges((es) => spliceEdges(es, anchor.id, node.id, mode).map(toEditorEdge))
      else if (mode === 'after') setEdges((es) => [...es, toEditorEdge({ id: edgeId(anchor.id, node.id), source: anchor.id, target: node.id })])
      // Frame the new step with its neighbours, so where it went in the chain is visible.
      const neighbours = new Set([anchor.id, node.id, ...edges.filter((e) => e.source === anchor.id || e.target === anchor.id).map((e) => (e.source === anchor.id ? e.target : e.source))])
      requestAnimationFrame(() => void fitView({ nodes: [...neighbours].map((id) => ({ id })), duration: 300, padding: 0.25, maxZoom: 1 }))
    },
    [nodes, edges, selectedNodes, presetFor, dropStep, setNodes, setEdges, fitView],
  )

  // ─── Changing steps ─────────────────────────────────────────────────────────────────────────────

  const updateStep = useCallback(
    (id: string, patch: { label?: string; data?: Partial<SpecNodeData> }) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id !== id
            ? n
            : {
                ...n,
                data: {
                  ...n.data,
                  label: patch.label ?? n.data.label,
                  specData: patch.data ? { ...n.data.specData, ...patch.data } : n.data.specData,
                },
              },
        ),
      )
    },
    [setNodes],
  )

  /**
   * Map an agent onto an agent step (null unmaps it). The step's name follows its agent unless someone named the
   * step on purpose (it still has the default name, or its previous agent's name).
   */
  const mapAgent = useCallback(
    (id: string, agent: Pick<Agent, 'slug' | 'name'> | null) => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== id) return n
          const d = n.data.specData
          const autoNamed = n.data.label === DEFAULT_NODE_LABELS.agent || (!!d.agentName && n.data.label === d.agentName) || (!!d.agentId && n.data.label === d.agentId)
          return {
            ...n,
            data: {
              ...n.data,
              label: agent && autoNamed ? agent.name : n.data.label,
              specData: { ...d, agentId: agent?.slug, agentName: agent?.name },
            },
          }
        }),
      )
    },
    [setNodes],
  )

  /** An agent was renamed: steps running it show the new name (and take it as their name if they had the old one). */
  const renameAgent = useCallback(
    (slug: string, name: string) => {
      setNodes((ns) =>
        ns.map((n) => {
          const d = n.data.specData
          if (n.data.kind !== 'agent' || d.agentId !== slug || d.agentName === name) return n
          return { ...n, data: { ...n.data, label: n.data.label === d.agentName ? name : n.data.label, specData: { ...d, agentName: name } } }
        }),
      )
    },
    [setNodes],
  )

  // ─── Connecting ─────────────────────────────────────────────────────────────────────────────────

  const isValidConnection = useCallback((c: Connection | Edge) => canConnect(nodes, edges, c) === null, [nodes, edges])

  const connect = useCallback(
    (c: Connection) => {
      const why = canConnect(nodes, edges, c)
      if (why) {
        toast.info(why)
        return
      }
      setEdges((es) => [...es, toEditorEdge({ id: edgeId(c.source, c.target), source: c.source, target: c.target })])
    },
    [nodes, edges, setEdges],
  )

  // ─── Deleting ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Delete steps and connections. The start step and the last end step stay. Removing a step from the middle
   * of a chain (one way in, one way out) joins its neighbours so the chain stays connected.
   */
  const deleteElements = useCallback(
    (nodeIds: string[], edgeIds: string[] = []) => {
      const allowed = deletableNodeIds(nodes, nodeIds)
      if (allowed.length < nodeIds.length) {
        const blocked = nodes.filter((n) => nodeIds.includes(n.id) && !allowed.includes(n.id))
        toast.info(blocked.some((n) => n.data.kind === 'trigger') ? 'The start step can’t be removed.' : 'A workflow needs at least one end step.')
      }
      const gone = new Set(allowed)
      const droppedEdges = new Set(edgeIds)
      const bridges: EditorEdge[] = []
      for (const id of allowed) {
        const ins = edges.filter((e) => e.target === id && !gone.has(e.source))
        const outs = edges.filter((e) => e.source === id && !gone.has(e.target))
        if (ins.length !== 1 || outs.length !== 1) continue
        const bridge = { source: ins[0].source, target: outs[0].target }
        const remaining = edges.filter((e) => e.source !== id && e.target !== id)
        if (canConnect(nodes, [...remaining, ...bridges], bridge) === null) {
          bridges.push(toEditorEdge({ id: edgeId(bridge.source, bridge.target), ...bridge }))
        }
      }
      if (allowed.length === 0 && droppedEdges.size === 0) return
      const next = removeNodes(nodes, edges, allowed)
      setNodes(next.nodes)
      setEdges([...next.edges.filter((e) => !droppedEdges.has(e.id)), ...bridges])
    },
    [nodes, edges, setNodes, setEdges],
  )

  const deleteSelection = useCallback(() => {
    if (selectedNodes.length || selectedEdges.length) {
      deleteElements(
        selectedNodes.map((n) => n.id),
        selectedEdges.map((e) => e.id),
      )
    }
  }, [selectedNodes, selectedEdges, deleteElements])

  // ─── Layout ─────────────────────────────────────────────────────────────────────────────────────

  const autoLayout = useCallback(() => {
    const positions = layoutWorkflow({ nodes, edges })
    setNodes((ns) => ns.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })))
    requestAnimationFrame(() => void fitView({ duration: 300, padding: 0.15 }))
  }, [nodes, edges, setNodes, fitView])

  const setMaxSteps = useCallback((maxSteps: number) => setBase((b) => ({ ...b, budget: { ...b.budget, maxSteps } })), [])

  // ─── Saving ─────────────────────────────────────────────────────────────────────────────────────

  /** Adopt what the server stored: its version, and the agent names it fills in from the catalog. */
  const adopt = useCallback(
    (res: WorkflowDetail) => {
      const serverData = new Map(res.spec.nodes.map((n) => [n.id, n.data]))
      setNodes((ns) =>
        ns.map((n) => {
          const agentName = serverData.get(n.id)?.agentName
          return n.data.kind === 'agent' && agentName && agentName !== n.data.specData.agentName
            ? { ...n, data: { ...n.data, specData: { ...n.data.specData, agentName } } }
            : n
        }),
      )
      const flow = specToBuilderFlow(res.spec)
      setSaved({ version: res.version, baseline: stableStringify(builderFlowToSpec(flow.nodes, flow.edges, res.spec, { name: res.name, description: res.description })) })
      setName(res.name)
      setDescription(res.description)
    },
    [setNodes],
  )

  const save = useCallback(
    async (opts: { overwrite?: boolean } = {}) => {
      if (saving) return
      if (errorCount > 0) {
        toast.error('Fix the problems listed under Checks before saving.')
        return
      }
      setSaving(true)
      try {
        if (source.id === null) {
          const created = await createWorkflow(projectKey, { name: spec.name, description: spec.description, spec, setAsDefault })
          setSaved((s) => ({ ...s, baseline: stableStringify(spec) }))
          toast.success(`${created.name} created`)
          onSaved(created, true)
          return
        }
        const version = opts.overwrite ? (await getWorkflow(projectKey, source.id)).version : saved.version
        const res = await updateWorkflow(projectKey, source.id, { version, name: spec.name, description: spec.description, spec })
        adopt(res)
        setConflict(false)
        toast.success(`Saved · version ${res.version}`)
        onSaved(res, false)
      } catch (err) {
        // A stale version (someone saved in between) offers reload / overwrite; other 409s (a disabled agent, a
        // taken name) are ordinary errors.
        if (err instanceof AppError && err.status === 409 && source.id !== null && /changed (since|while)/i.test(err.message)) {
          setConflict(true)
        } else {
          toast.error(err instanceof AppError ? err.message : 'Could not save the workflow.')
        }
      } finally {
        setSaving(false)
      }
    },
    [saving, errorCount, source.id, projectKey, spec, setAsDefault, saved.version, adopt, onSaved],
  )

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty || isNew) return
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, isNew])

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    spec,
    name,
    setName,
    description,
    setDescription,
    setMaxSteps,
    setAsDefault,
    setSetAsDefault,
    isNew,
    dirty,
    saving,
    version: saved.version,
    conflict,
    dismissConflict: () => setConflict(false),
    validation,
    issues,
    errorCount,
    warningCount,
    selectedNodes,
    selectedEdges,
    selectStep,
    dropStep,
    insertStep,
    updateStep,
    mapAgent,
    renameAgent,
    isValidConnection,
    connect,
    deleteElements,
    deleteSelection,
    autoLayout,
    save,
  }
}

export type WorkflowEditorState = ReturnType<typeof useWorkflowEditor>
export type { SpecNodeKind }
