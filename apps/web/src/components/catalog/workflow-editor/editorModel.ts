// The workflow editor's model: React Flow node/edge types over the shared builder model (@sdlc/core), the
// drag-and-drop payload the palette sends, and the per-step problems the editor shows before the server would
// refuse a save (unknown or disabled agents and skills, harnesses the project doesn't allow, unreachable steps).

import type { Edge, Node } from '@xyflow/react'
import type { Agent } from '@sdlc/contracts'
import type { BuilderNodeData, SpecNodeKind, WorkflowSpec } from '@sdlc/core'

export type EditorNode = Node<BuilderNodeData, SpecNodeKind>
export type EditorEdge = Edge

/** The MIME type the palette puts on a drag, so the canvas ignores unrelated drops (files, text). */
export const PALETTE_MIME = 'application/x-sdlc-workflow-step'

/** What a palette item carries: a step kind, or an existing agent to add as an already-mapped agent step. */
export type PalettePayload = { kind: SpecNodeKind; agentSlug?: string }

export interface StepIssue {
  nodeId: string
  level: 'error' | 'warning'
  message: string
}

/** JSON with object keys sorted, so two specs compare equal whatever order the server stored their keys in. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** Steps reachable from the trigger along edges and go-to targets. */
function reachable(spec: WorkflowSpec): Set<string> {
  const next = new Map<string, string[]>()
  for (const e of spec.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target])
  for (const n of spec.nodes) {
    if (n.kind === 'goto' && n.data.targetId) next.set(n.id, [...(next.get(n.id) ?? []), n.data.targetId])
  }
  const start = spec.nodes.find((n) => n.kind === 'trigger')
  const seen = new Set<string>()
  const queue = start ? [start.id] : []
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(next.get(id) ?? []))
  }
  return seen
}

/**
 * Problems with individual steps. Errors are things the server would refuse; warnings still save. `catalog` is
 * null while the project's agents load (agent checks are skipped until then).
 */
export function stepIssues(spec: WorkflowSpec, catalog: Agent[] | null, allowedHarnesses: readonly string[]): StepIssue[] {
  const issues: StepIssue[] = []
  const bySlug = new Map((catalog ?? []).map((a) => [a.slug, a]))
  const reached = reachable(spec)
  const ids = new Set(spec.nodes.map((n) => n.id))
  const add = (nodeId: string, level: StepIssue['level'], message: string): void => void issues.push({ nodeId, level, message })

  for (const n of spec.nodes) {
    const d = n.data
    if (!n.label.trim()) add(n.id, 'error', 'Give this step a name.')
    if (n.kind !== 'trigger' && !reached.has(n.id)) add(n.id, 'error', 'Nothing leads to this step. Connect an earlier step to it.')
    if (n.kind !== 'end' && n.kind !== 'goto' && !spec.edges.some((e) => e.source === n.id)) {
      add(n.id, 'warning', 'Nothing follows this step, so the run stops here.')
    }
    if (n.kind === 'goto' && (!d.targetId || !ids.has(d.targetId))) add(n.id, 'error', 'Choose the step to go to.')
    if (n.kind !== 'agent') continue

    if (!d.agentId) add(n.id, 'warning', 'No agent assigned.')
    else if (catalog) {
      const agent = bySlug.get(d.agentId)
      if (!agent || agent.kind !== 'agent') add(n.id, 'error', `The agent “${d.agentName ?? d.agentId}” doesn’t exist in this project.`)
      else if (!agent.usable) add(n.id, 'error', `You can’t use ${agent.name} (restricted to a higher role).`)
      else if (!agent.enabled) add(n.id, 'error', `${agent.name} is switched off for this project.`)
    }
    if (catalog) {
      for (const slug of d.skills ?? []) {
        const skill = bySlug.get(slug)
        if (!skill || skill.kind !== 'skill') add(n.id, 'error', `The skill “${slug}” doesn’t exist in this project.`)
        else if (!skill.usable || !skill.enabled) add(n.id, 'error', `The skill ${skill.name} isn’t available.`)
      }
    }
    if (d.harness && allowedHarnesses.length && !allowedHarnesses.includes(d.harness)) {
      add(n.id, 'error', 'This project doesn’t allow the pinned harness.')
    }
  }
  return issues
}

/** The worst issue per step, for the badge on its node. */
export function worstIssueByNode(issues: StepIssue[]): Map<string, StepIssue> {
  const out = new Map<string, StepIssue>()
  for (const i of issues) {
    const prev = out.get(i.nodeId)
    if (!prev || (prev.level === 'warning' && i.level === 'error')) out.set(i.nodeId, i)
  }
  return out
}
