// The editable canvas model: WorkflowSpec ⇄ React Flow nodes/edges for a workflow *builder*.
//
// Unlike specToFlow (read-only, lossy: it keeps only what a node draws), builder nodes carry the node's FULL
// SpecNodeData so spec → canvas → spec is lossless — including fields the canvas never shows and keys the server
// keeps that this IR doesn't know about. Framework-free: the node/edge shapes are local and structurally compatible
// with React Flow's Node/Edge, so the web app and the extension can both use it and it stays unit-testable.

import type { SpecEdge, SpecNode, SpecNodeData, SpecNodeKind, WorkflowSpec } from '../spec'
import { layoutWorkflow, NODE_WIDTH } from '../layout/workflowLayout'

export interface BuilderNodeData extends Record<string, unknown> {
  kind: SpecNodeKind
  label: string
  /** The node's complete kind-specific payload, kept verbatim so saving loses nothing. */
  specData: SpecNodeData
}

export interface BuilderNode {
  id: string
  type: SpecNodeKind
  position: { x: number; y: number }
  data: BuilderNodeData
}

export interface BuilderEdge {
  id: string
  source: string
  target: string
}

/** What the builder functions read from a node — React Flow's Node<BuilderNodeData> satisfies it. */
export interface BuilderNodeLike {
  id: string
  position: { x: number; y: number }
  data: BuilderNodeData
}

/** What the builder functions read from an edge — React Flow's Edge satisfies it. */
export interface EdgeLike {
  source: string
  target: string
}

/** The label a freshly added node of each kind starts with. */
export const DEFAULT_NODE_LABELS: Record<SpecNodeKind, string> = {
  trigger: 'Start',
  agent: 'New agent step',
  gate: 'Gate',
  approval: 'Approval',
  condition: 'Condition',
  'set-variable': 'Set variable',
  goto: 'Go to',
  end: 'Done',
}

/** Horizontal room between two nodes placed next to each other. */
export const NODE_GAP_X = 80

/** The secondary line shown under a node's label, derived from its kind-specific payload. */
export function nodeSubtitle(node: Pick<SpecNode, 'kind' | 'data'>): string | undefined {
  const d = node.data
  switch (node.kind) {
    case 'agent':
      return d.sdlcStep ? `step: ${d.sdlcStep}` : d.agentName
    case 'gate':
      return d.gateStep ? `gate: ${d.gateStep}` : undefined
    case 'approval':
      return d.question
    case 'condition':
      return d.predicate || (d.branch === 'ELSE' ? 'otherwise' : undefined)
    case 'set-variable':
      return d.variable ? `${d.variable} = ${d.value ?? ''}` : undefined
    case 'goto':
      return d.targetId ? `→ ${d.targetId}` : undefined
    default:
      return undefined
  }
}

export function edgeId(source: string, target: string): string {
  return `e_${source}_${target}`
}

/**
 * Spec → builder nodes/edges. Saved positions are kept; when any node lacks one (legacy specs, chat drafts) the
 * missing ones come from the Dagre layout.
 */
export function specToBuilderFlow(spec: WorkflowSpec): { nodes: BuilderNode[]; edges: BuilderEdge[] } {
  const needsLayout = spec.nodes.some((n) => !n.position)
  const laid = needsLayout ? layoutWorkflow({ nodes: spec.nodes, edges: spec.edges }) : new Map<string, { x: number; y: number }>()
  const nodes: BuilderNode[] = spec.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position ?? laid.get(n.id) ?? { x: 0, y: 0 },
    data: { kind: n.kind, label: n.label, specData: { ...n.data } },
  }))
  const edges: BuilderEdge[] = dedupeEdges(spec.edges).map((e) => ({ id: edgeId(e.source, e.target), source: e.source, target: e.target }))
  return { nodes, edges }
}

/** Drop empty values (undefined, null, blank strings, empty arrays) so a saved spec carries only what is set. */
export function cleanNodeData(data: SpecNodeData): SpecNodeData {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out as SpecNodeData
}

function dedupeEdges(edges: readonly EdgeLike[]): SpecEdge[] {
  const seen = new Set<string>()
  const out: SpecEdge[] = []
  for (const e of edges) {
    const key = `${e.source}\u0000${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ source: e.source, target: e.target })
  }
  return out
}

/**
 * Builder nodes/edges → spec. `base` supplies everything the canvas doesn't edit (budget, pattern, specVersion);
 * `meta` overrides the name/description. Positions are rounded so a save doesn't churn on sub-pixel drags.
 */
export function builderFlowToSpec(
  nodes: readonly BuilderNodeLike[],
  edges: readonly EdgeLike[],
  base: WorkflowSpec,
  meta: { name?: string; description?: string } = {},
): WorkflowSpec {
  const ids = new Set(nodes.map((n) => n.id))
  return {
    ...base,
    name: meta.name ?? base.name,
    description: meta.description ?? base.description,
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      label: n.data.label,
      data: cleanNodeData(n.data.specData),
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: dedupeEdges(edges.filter((e) => ids.has(e.source) && ids.has(e.target))),
  }
}

/**
 * A readable node id that isn't taken yet: `base`, then `base-2`, `base-3`… Only lowercase letters, digits and
 * single hyphens — the orchestrator builds LangGraph node names as `<id>__plan_req` and reserves `:`, so ids must
 * never contain `__` or `:`.
 */
export function makeNodeId(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  const stem =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'step'
  if (!taken.has(stem)) return stem
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/** A new node of `kind`; `preset` pre-fills it (e.g. an agent dropped from the palette arrives already mapped). */
export function blankNode(
  kind: SpecNodeKind,
  position: { x: number; y: number },
  existingIds: Iterable<string>,
  preset: { label?: string; data?: SpecNodeData; idBase?: string } = {},
): BuilderNode {
  return {
    id: makeNodeId(preset.idBase ?? kind, existingIds),
    type: kind,
    position,
    data: { kind, label: preset.label ?? DEFAULT_NODE_LABELS[kind], specData: { ...(preset.data ?? {}) } },
  }
}

/**
 * Guarantee a trigger and an end exist (hand-edited or legacy specs may lack one). A missing trigger is wired to
 * every root, a missing end from every leaf.
 */
export function ensureStartEnd(
  nodes: readonly BuilderNode[],
  edges: readonly BuilderEdge[],
): { nodes: BuilderNode[]; edges: BuilderEdge[] } {
  let n = [...nodes]
  let e = [...edges]
  if (!n.some((node) => node.data.kind === 'trigger')) {
    const minX = n.reduce((m, node) => Math.min(m, node.position.x), 0)
    const trigger = blankNode('trigger', { x: minX - NODE_WIDTH - NODE_GAP_X, y: 0 }, n.map((x) => x.id), { idBase: 'trigger' })
    const roots = n.filter((node) => !e.some((ed) => ed.target === node.id))
    n = [trigger, ...n]
    e = [...e, ...roots.map((r) => ({ id: edgeId(trigger.id, r.id), source: trigger.id, target: r.id }))]
  }
  if (!n.some((node) => node.data.kind === 'end')) {
    const maxX = n.reduce((m, node) => Math.max(m, node.position.x), 0)
    const end = blankNode('end', { x: maxX + NODE_WIDTH + NODE_GAP_X, y: 0 }, n.map((x) => x.id), { idBase: 'end' })
    const leaves = n.filter((node) => !e.some((ed) => ed.source === node.id))
    n = [...n, end]
    e = [...e, ...leaves.map((l) => ({ id: edgeId(l.id, end.id), source: l.id, target: end.id }))]
  }
  return { nodes: n, edges: e }
}

/**
 * Why `source → target` can't be drawn, or null when it can. Branching, fan-out and loops back to earlier steps
 * are all allowed — the save-time validation (validateWorkflowSpec) checks the graph as a whole.
 */
export function canConnect(
  nodes: readonly BuilderNodeLike[],
  edges: readonly EdgeLike[],
  conn: { source: string | null; target: string | null },
): string | null {
  const { source, target } = conn
  if (!source || !target) return 'Connect two steps.'
  if (source === target) return 'A step can’t lead to itself.'
  const from = nodes.find((n) => n.id === source)
  const to = nodes.find((n) => n.id === target)
  if (!from || !to) return 'That step no longer exists.'
  if (to.data.kind === 'trigger') return 'Nothing can lead into the start step.'
  if (from.data.kind === 'end') return 'An end step finishes the run; nothing follows it.'
  if (edges.some((e) => e.source === source && e.target === target)) return 'Those steps are already connected.'
  return null
}

/**
 * Of the nodes asked to be deleted, those that may be: never the trigger, and never the last end step.
 */
export function deletableNodeIds(nodes: readonly BuilderNodeLike[], requested: Iterable<string>): string[] {
  const wanted = new Set(requested)
  const ends = nodes.filter((n) => n.data.kind === 'end')
  const endsKept = ends.filter((n) => !wanted.has(n.id)).length
  let spareEnds = endsKept > 0 ? Infinity : ends.length - 1
  const out: string[] = []
  for (const n of nodes) {
    if (!wanted.has(n.id) || n.data.kind === 'trigger') continue
    if (n.data.kind === 'end') {
      if (spareEnds <= 0) continue
      spareEnds--
    }
    out.push(n.id)
  }
  return out
}

/**
 * Edges after splicing `newId` next to `anchorId`: `after` moves the anchor's outgoing edges onto the new node
 * (anchor → new → old successors); `before` moves its incoming edges (old predecessors → new → anchor).
 */
export function spliceEdges<E extends BuilderEdge>(
  edges: readonly E[],
  anchorId: string,
  newId: string,
  mode: 'after' | 'before',
): Array<E | BuilderEdge> {
  if (mode === 'after') {
    const moved = edges.filter((e) => e.source === anchorId)
    const kept = edges.filter((e) => e.source !== anchorId)
    return [
      ...kept,
      { id: edgeId(anchorId, newId), source: anchorId, target: newId },
      ...moved.map((e) => ({ id: edgeId(newId, e.target), source: newId, target: e.target })),
    ]
  }
  const moved = edges.filter((e) => e.target === anchorId)
  const kept = edges.filter((e) => e.target !== anchorId)
  return [
    ...kept,
    ...moved.map((e) => ({ id: edgeId(e.source, newId), source: e.source, target: newId })),
    { id: edgeId(newId, anchorId), source: newId, target: anchorId },
  ]
}

/** Remove nodes and every edge touching them; a goto pointing at a removed node loses its target. */
export function removeNodes<N extends BuilderNodeLike, E extends EdgeLike>(
  nodes: readonly N[],
  edges: readonly E[],
  ids: Iterable<string>,
): { nodes: N[]; edges: E[] } {
  const gone = new Set(ids)
  return {
    nodes: nodes
      .filter((n) => !gone.has(n.id))
      .map((n) =>
        n.data.kind === 'goto' && n.data.specData.targetId && gone.has(n.data.specData.targetId)
          ? ({ ...n, data: { ...n.data, specData: { ...n.data.specData, targetId: undefined } } } as N)
          : n,
      ),
    edges: edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
  }
}
