// Utilities for converting between WorkflowSpec and React Flow's node/edge model in builder mode.
//
// The key difference from specToFlow (host-side) is that builder nodes carry the FULL SpecNodeData
// so the round-trip spec → nodes → spec is lossless when the user saves (including fields only some runs use,
// such as an agent step's pinned `harness`).

import type { Node, Edge } from '@xyflow/react'
import type { WorkflowSpec, SpecNode, SpecNodeData, SpecNodeKind } from '../../runtime/spec'
import type { AgentSummary } from '../messages'
import { blankSpec } from '../../runtime/specUtils'
export { blankSpec } from '../../runtime/specUtils'

export interface BuilderNodeData extends Record<string, unknown> {
  kind: SpecNodeKind
  label: string
  subtitle?: string
  branch?: 'IF' | 'ELSE_IF' | 'ELSE'
  agentId?: string
  /** Full SpecNodeData stored so the round-trip to WorkflowSpec is lossless. */
  specData: SpecNodeData
}

export type BuilderNode = Node<BuilderNodeData>

/** Simple left-to-right position grid (used before Dagre re-layout). */
function defaultPosition(index: number): { x: number; y: number } {
  return { x: (index % 5) * 240, y: Math.floor(index / 5) * 120 }
}

function subtitleFor(node: SpecNode): string | undefined {
  const d = node.data
  switch (node.kind) {
    case 'agent': return d.sdlcStep ? `step: ${d.sdlcStep}` : d.agentName
    case 'gate': return d.gateStep ? `gate: ${d.gateStep}` : undefined
    case 'approval': return d.question
    case 'condition': return d.predicate || (d.branch === 'ELSE' ? 'otherwise' : undefined)
    case 'set-variable': return d.variable ? `${d.variable} = ${d.value ?? ''}` : undefined
    case 'goto': return d.targetId ? `→ ${d.targetId}` : undefined
    default: return undefined
  }
}

/** Convert a WorkflowSpec to React Flow nodes + edges for the builder canvas. */
export function specToBuilderFlow(spec: WorkflowSpec): { nodes: BuilderNode[]; edges: Edge[] } {
  const nodes: BuilderNode[] = spec.nodes.map((n, i) => ({
    id: n.id,
    type: n.kind,
    position: n.position ?? defaultPosition(i),
    data: {
      kind: n.kind,
      label: n.label,
      subtitle: subtitleFor(n),
      branch: n.data.branch,
      agentId: n.data.agentId,
      specData: { ...n.data },
    },
  }))

  const edges: Edge[] = spec.edges.map((e, i) => ({
    id: `e${i}_${e.source}_${e.target}`,
    source: e.source,
    target: e.target,
  }))

  return { nodes, edges }
}

/** Convert React Flow builder nodes + edges back to a WorkflowSpec. */
export function builderFlowToSpec(
  nodes: BuilderNode[],
  edges: Edge[],
  existing: WorkflowSpec,
): WorkflowSpec {
  const specNodes: SpecNode[] = nodes.map((n) => ({
    id: n.id,
    kind: n.data.kind,
    label: n.data.label,
    data: { ...n.data.specData },
    position: n.position,
  }))

  const specEdges = edges.map((e) => ({ source: e.source, target: e.target }))

  return {
    ...existing,
    nodes: specNodes,
    edges: specEdges,
  }
}

/** Generate a unique node id. */
export function makeNodeId(kind: SpecNodeKind): string {
  return `${kind}-${Date.now()}`
}

/**
 * Walk the graph from its trigger node following single-in/single-out edges (the same
 * linearity test NodeDetailPanel uses for its earlier/later buttons) until a branch or
 * the end node is reached. Returns the ids in execution order, trigger and end included.
 * Nodes past a branch point (e.g. inside a condition) are not part of this chain and are
 * left untouched by the Settings-tab reorder UI.
 */
export function linearChainIds(nodes: BuilderNode[], edges: Edge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outboundOf = (id: string): Edge[] => edges.filter((e) => e.source === id)
  const inboundOf = (id: string): Edge[] => edges.filter((e) => e.target === id)

  const trigger = nodes.find((n) => n.data.kind === 'trigger')
  if (!trigger) return []

  const chain = [trigger.id]
  const seen = new Set(chain)
  let current = trigger.id
  for (;;) {
    const out = outboundOf(current)
    if (out.length !== 1) break
    const nextId = out[0].target
    if (seen.has(nextId) || !byId.has(nextId)) break
    if (inboundOf(nextId).length !== 1) break
    chain.push(nextId)
    seen.add(nextId)
    current = nextId
    if (byId.get(nextId)!.data.kind === 'end') break
  }
  return chain
}

/** One row in the Settings-tab "Agent Execution Order" list. */
export interface AgentOrderEntry {
  id: string
  label: string
  agentId?: string
}

/** Ordered list of agent-kind nodes found in the workflow's linear chain. */
export function getAgentOrder(nodes: BuilderNode[], edges: Edge[]): AgentOrderEntry[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return linearChainIds(nodes, edges)
    .map((id) => byId.get(id))
    .filter((n): n is BuilderNode => !!n && n.data.kind === 'agent')
    .map((n) => ({ id: n.id, label: n.data.label, agentId: n.data.agentId }))
}

/**
 * Rebuild edges so the linear chain's agent nodes run in `newAgentOrder` while every
 * non-agent step (gates, approvals, trigger, end, …) keeps its existing slot in the chain.
 * Edges outside the linear chain (e.g. branches) are left as-is.
 */
export function reorderAgents(nodes: BuilderNode[], edges: Edge[], newAgentOrder: string[]): Edge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const chain = linearChainIds(nodes, edges)
  if (chain.length === 0) return edges

  let cursor = 0
  const reordered = chain.map((id) => (byId.get(id)?.data.kind === 'agent' ? newAgentOrder[cursor++] : id))

  const chainSet = new Set(chain)
  const outsideEdges = edges.filter((e) => !(chainSet.has(e.source) && chainSet.has(e.target)))
  const chainEdges: Edge[] = reordered.slice(0, -1).map((source, i) => ({
    id: `e_${source}_${reordered[i + 1]}`,
    source,
    target: reordered[i + 1],
  }))
  return [...outsideEdges, ...chainEdges]
}

/**
 * Guarantee a `trigger` and `end` node always exist. If either is missing (deleted by the
 * user, or absent from a hand-edited/legacy spec), synthesize it and wire it to the current
 * graph's roots (nodes with no inbound edge) or leaves (nodes with no outbound edge).
 */
export function ensureStartEnd(nodes: BuilderNode[], edges: Edge[]): { nodes: BuilderNode[]; edges: Edge[] } {
  let n = nodes
  let e = edges

  const hasTrigger = n.some((node) => node.data.kind === 'trigger')
  if (!hasTrigger) {
    const trigger = blankNode('trigger', { x: -240, y: 0 })
    const roots = n.filter((node) => !e.some((ed) => ed.target === node.id))
    n = [trigger, ...n]
    e = [...e, ...roots.map((r) => ({ id: `e_${trigger.id}_${r.id}`, source: trigger.id, target: r.id }))]
  }

  const hasEnd = n.some((node) => node.data.kind === 'end')
  if (!hasEnd) {
    const maxX = n.reduce((m, node) => Math.max(m, node.position.x), 0)
    const end = blankNode('end', { x: maxX + 240, y: 0 })
    const leaves = n.filter((node) => !e.some((ed) => ed.source === node.id))
    n = [...n, end]
    e = [...e, ...leaves.map((l) => ({ id: `e_${l.id}_${end.id}`, source: l.id, target: end.id }))]
  }

  return { nodes: n, edges: e }
}

/** Create a blank SpecNode of the given kind. */
export function blankNode(kind: SpecNodeKind, position: { x: number; y: number }): BuilderNode {
  const labelMap: Record<SpecNodeKind, string> = {
    trigger: 'Start',
    agent: 'New Agent',
    gate: 'Gate',
    approval: 'Approval',
    condition: 'Condition',
    'set-variable': 'Set Variable',
    goto: 'Go To',
    end: 'End',
  }
  const id = makeNodeId(kind)
  const data: BuilderNodeData = {
    kind,
    label: labelMap[kind],
    specData: {},
  }
  return { id, type: kind, position, data }
}


/** Trigger configuration for a generated workflow. */
export interface WorkflowTrigger {
  type: 'issue' | 'manual'
  workItemType?: string
}

/**
 * Build a sequential WorkflowSpec from a set of selected agents:
 *   trigger → agent₁ → agent₂ → … → end, with chained edges.
 * Each agent node carries its agentId/agentName so the run-time resolver and Add Agent modal match.
 * Default trigger is an Azure DevOps issue trigger so ▶ Start fetches the user's assigned work items.
 */
export function specFromAgents(
  name: string,
  agents: AgentSummary[],
  trigger: WorkflowTrigger = { type: 'issue' },
): WorkflowSpec {
  const base = blankSpec(name)

  const triggerNode: SpecNode =
    trigger.type === 'issue'
      ? {
          id: 'trigger',
          kind: 'trigger',
          label: 'User Story Trigger',
          data: {
            triggerType: 'issue',
            issueSource: 'azure-devops',
            workItemType: trigger.workItemType?.trim() || 'User Story',
          },
        }
      : { id: 'trigger', kind: 'trigger', label: 'Start', data: {} }

  if (agents.length === 0) {
    return { ...base, nodes: [triggerNode, { id: 'end', kind: 'end', label: 'Done', data: {} }], edges: [{ source: 'trigger', target: 'end' }] }
  }

  const agentNodes: SpecNode[] = agents.map((a, i) => ({
    id: `agent-${i}-${a.id.replace(/[^A-Za-z0-9._-]+/g, '-')}`.slice(0, 80),
    kind: 'agent',
    label: a.name,
    data: { agentId: a.id, agentName: a.name, sdlcStep: 'implement' },
  }))

  const ordered = ['trigger', ...agentNodes.map((n) => n.id), 'end']
  const edges = ordered.slice(0, -1).map((source, i) => ({ source, target: ordered[i + 1] }))

  return {
    ...base,
    nodes: [triggerNode, ...agentNodes, { id: 'end', kind: 'end', label: 'Done', data: {} }],
    edges,
  }
}

/** Convert WorkflowSpec nodes/edges to a YAML string (simplified for the extension). */
export function specToYaml(spec: WorkflowSpec): string {
  const lines: string[] = [
    `kind: workflow`,
    `name: ${spec.name}`,
    `description: ${spec.description || '(none)'}`,
    `pattern: ${spec.pattern}`,
    `actions:`,
  ]
  for (const node of spec.nodes) {
    if (node.kind === 'trigger') continue
    lines.push(`  - kind: ${node.kind}`)
    lines.push(`    id: ${node.id}`)
    lines.push(`    label: ${node.label}`)
    if (node.data.agentId) lines.push(`    agentId: ${node.data.agentId}`)
    if (node.data.agentName) lines.push(`    agentName: ${node.data.agentName}`)
    if (node.data.sdlcStep) lines.push(`    sdlcStep: ${node.data.sdlcStep}`)
    if (node.data.outputVar) lines.push(`    outputVar: ${node.data.outputVar}`)
    if (node.data.harness) lines.push(`    harness: ${node.data.harness}`)
    if (node.data.gateStep) lines.push(`    gateStep: ${node.data.gateStep}`)
    if (node.data.gateResultVar) lines.push(`    gateResultVar: ${node.data.gateResultVar}`)
    if (node.data.predicate) lines.push(`    predicate: "${node.data.predicate}"`)
    if (node.data.branch) lines.push(`    branch: ${node.data.branch}`)
    if (node.data.variable) lines.push(`    variable: ${node.data.variable}`)
    if (node.data.value) lines.push(`    value: "${node.data.value}"`)
    if (node.data.targetId) lines.push(`    targetId: ${node.data.targetId}`)
    const nextEdges = spec.edges.filter((e) => e.source === node.id)
    if (nextEdges.length > 0) {
      lines.push(`    next: [${nextEdges.map((e) => e.target).join(', ')}]`)
    }
  }
  return lines.join('\n')
}

/** Generate Python sample code for a workflow. */
export function specToPython(spec: WorkflowSpec): string {
  const name = spec.name
  return `# Before running:
#   pip install azure-ai-projects>=2.1.0

import os
from azure.identity import DefaultAzureCredential
from azure.ai.projects import AIProjectClient

endpoint = os.environ.get(
    "AZURE_AI_PROJECT_ENDPOINT",
    "https://your-project.services.ai.azure.com/api/projects/proj-default"
)

project_client = AIProjectClient(
    endpoint=endpoint,
    credential=DefaultAzureCredential(),
)

with project_client:
    openai_client = project_client.get_openai_client()
    conversation = openai_client.conversations.create()

    stream = openai_client.responses.create(
        conversation=conversation.id,
        extra_body={"agent_reference": {"name": "${name}", "type": "agent_reference"}},
        input="Hi ${name}",
        stream=True,
    )

    for event in stream:
        if hasattr(event, "delta") and hasattr(event.delta, "text"):
            print(event.delta.text, end="", flush=True)
`
}

/** Generate TypeScript sample code for a workflow. */
export function specToTypeScript(spec: WorkflowSpec): string {
  const name = spec.name
  return `// Before running:
//   npm install @azure/ai-projects @azure/identity

import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";

const endpoint =
  process.env.AZURE_AI_PROJECT_ENDPOINT ??
  "https://your-project.services.ai.azure.com/api/projects/proj-default";

const projectClient = new AIProjectClient(endpoint, new DefaultAzureCredential());

async function main() {
  const openaiClient = await projectClient.getOpenAIClient();
  const conversation = await openaiClient.conversations.create();

  const stream = await openaiClient.responses.create({
    conversation: conversation.id,
    extra_body: { agent_reference: { name: "${name}", type: "agent_reference" } },
    input: "Hi ${name}",
    stream: true,
  });

  for await (const event of stream) {
    if ("delta" in event && event.delta && "text" in event.delta) {
      process.stdout.write(String(event.delta.text));
    }
  }
}

main().catch(console.error);
`
}
