// Linear workflow drafts — the shape the chat's Workflows agent (and its Review form) works in — and the checks
// every saved WorkflowSpec must pass. A draft is an ordered list of steps; it compiles to trigger → steps → end
// with straight edges, which is all the "Story delivery" template needs. Branching (condition/goto) stays a
// canvas-only feature: `specToWorkflowDraft` refuses specs it can't represent instead of flattening them.

import type { SdlcStep } from '../eval/sdlcSteps'
import { DEFAULT_RUN_BUDGET, type SpecEdge, type SpecNode, type WorkflowSpec } from './spec'

export const WORKFLOW_DRAFT_STEP_KINDS = ['agent', 'approval', 'gate'] as const
export type WorkflowDraftStepKind = (typeof WORKFLOW_DRAFT_STEP_KINDS)[number]

export interface WorkflowDraftStep {
  /** Stable node id (kebab-case). Kept when an existing workflow is edited so run history still lines up. */
  id: string
  kind: WorkflowDraftStepKind
  label: string
  /** Agent steps: the catalog agent slug. Null/absent = not mapped yet (map it later on the Workflow page). */
  agentSlug?: string | null
  /** Agent steps: skill slugs the agent may load in this step. */
  skills?: string[]
  /** Agent steps: the SDLC step the output is gated at. Gate steps: the policy they enforce. */
  sdlcStep?: SdlcStep | null
  /** Approval steps: the question the approver answers. */
  question?: string | null
}

export interface WorkflowDraftData {
  name: string
  description: string
  /** How a run starts: picked up by hand, or seeded from an Azure Boards work item. */
  trigger: 'manual' | 'issue'
  steps: WorkflowDraftStep[]
  /** Make it the project's default workflow once it is saved. */
  setAsDefault: boolean
}

const TRIGGER_ID = 'start'
const END_ID = 'done'

/** kebab-case id from a label, unique among `taken`. */
export function draftStepId(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'step'
  let id = base
  for (let i = 2; taken.has(id) || id === TRIGGER_ID || id === END_ID; i++) id = `${base}-${i}`
  return id
}

/**
 * Compile a draft into a WorkflowSpec. `agentNames` maps slugs to display names (from the catalog); a slug with
 * no name falls back to itself. Duplicate or empty step ids are re-derived from the labels.
 */
export function workflowDraftToSpec(draft: WorkflowDraftData, agentNames: Record<string, string> = {}): WorkflowSpec {
  const taken = new Set<string>()
  const steps: SpecNode[] = draft.steps.map((s) => {
    const id = s.id && !taken.has(s.id) && s.id !== TRIGGER_ID && s.id !== END_ID ? s.id : draftStepId(s.label, taken)
    taken.add(id)
    const label = s.label.trim() || id
    if (s.kind === 'agent') {
      const data: SpecNode['data'] = {}
      if (s.agentSlug) {
        data.agentId = s.agentSlug
        data.agentName = agentNames[s.agentSlug] ?? s.agentSlug
      }
      if (s.skills?.length) data.skills = [...new Set(s.skills)]
      if (s.sdlcStep) data.sdlcStep = s.sdlcStep
      return { id, kind: 'agent', label, data }
    }
    if (s.kind === 'approval') {
      return { id, kind: 'approval', label, data: { question: s.question?.trim() || `Approve "${label}"?` } }
    }
    return { id, kind: 'gate', label, data: s.sdlcStep ? { gateStep: s.sdlcStep } : {} }
  })
  const nodes: SpecNode[] = [
    { id: TRIGGER_ID, kind: 'trigger', label: draft.trigger === 'issue' ? 'Work item picked' : 'Story picked up', data: { triggerType: draft.trigger } },
    ...steps,
    { id: END_ID, kind: 'end', label: 'Done', data: {} },
  ]
  const edges: SpecEdge[] = nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id }))
  return {
    specVersion: 1,
    name: draft.name.trim(),
    description: draft.description.trim(),
    pattern: 'sequential',
    budget: DEFAULT_RUN_BUDGET,
    nodes,
    edges,
  }
}

export type SpecToDraftResult = { ok: true; draft: WorkflowDraftData } | { ok: false; reason: string }

/**
 * The draft for an existing spec, when it is a straight line of agent/approval/gate steps between one trigger and
 * one end. Anything with branches or loops can't round-trip through a linear draft, so it is refused.
 */
export function specToWorkflowDraft(spec: WorkflowSpec, isDefault = false): SpecToDraftResult {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]))
  const triggers = spec.nodes.filter((n) => n.kind === 'trigger')
  if (triggers.length !== 1) return { ok: false, reason: 'The workflow does not have exactly one trigger.' }
  const unsupported = spec.nodes.find((n) => !['trigger', 'agent', 'approval', 'gate', 'end'].includes(n.kind))
  if (unsupported) {
    return { ok: false, reason: `It has a ${unsupported.kind} step ("${unsupported.label}"), which only the canvas can edit.` }
  }
  const next = new Map<string, string[]>()
  for (const e of spec.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target])

  const steps: WorkflowDraftStep[] = []
  const seen = new Set<string>()
  let current = triggers[0]
  for (;;) {
    seen.add(current.id)
    const outs = next.get(current.id) ?? []
    if (current.kind === 'end') {
      if (outs.length > 0) return { ok: false, reason: 'A step continues after the end.' }
      break
    }
    if (outs.length !== 1) return { ok: false, reason: `"${current.label}" branches, which only the canvas can edit.` }
    const node = byId.get(outs[0])
    if (!node) return { ok: false, reason: `An edge points at a missing step (${outs[0]}).` }
    if (seen.has(node.id)) return { ok: false, reason: 'The workflow loops back, which only the canvas can edit.' }
    if (node.kind === 'agent') {
      steps.push({
        id: node.id,
        kind: 'agent',
        label: node.label,
        agentSlug: node.data.agentId ?? null,
        skills: node.data.skills ?? [],
        sdlcStep: node.data.sdlcStep ?? null,
      })
    } else if (node.kind === 'approval') {
      steps.push({ id: node.id, kind: 'approval', label: node.label, question: node.data.question ?? null })
    } else if (node.kind === 'gate') {
      steps.push({ id: node.id, kind: 'gate', label: node.label, sdlcStep: node.data.gateStep ?? null })
    }
    current = node
  }
  if (seen.size !== spec.nodes.length) return { ok: false, reason: 'Some steps are not on the main path.' }
  return {
    ok: true,
    draft: {
      name: spec.name,
      description: spec.description,
      trigger: triggers[0].data.triggerType === 'issue' ? 'issue' : 'manual',
      steps,
      setAsDefault: isDefault,
    },
  }
}

export interface SpecValidation {
  /** Problems that make the spec unusable; it must not be saved. */
  errors: string[]
  /** Things worth fixing that don't block saving (e.g. an agent step nobody is mapped to yet). */
  warnings: string[]
}

/** Structural checks for a WorkflowSpec before it is saved: ids, edges, one trigger, everything reachable. */
export function validateWorkflowSpec(spec: WorkflowSpec): SpecValidation {
  const errors: string[] = []
  const warnings: string[] = []
  if (spec.specVersion !== 1) errors.push('Unsupported spec version.')
  if (!spec.name?.trim()) errors.push('The workflow needs a name.')
  if (!Array.isArray(spec.nodes) || !Array.isArray(spec.edges)) {
    errors.push('The workflow has no steps.')
    return { errors, warnings }
  }

  const ids = new Set<string>()
  for (const n of spec.nodes) {
    if (!n.id) errors.push(`A step ("${n.label}") has no id.`)
    else if (ids.has(n.id)) errors.push(`Two steps share the id "${n.id}".`)
    ids.add(n.id)
    if (!n.label?.trim()) errors.push(`Step "${n.id}" has no label.`)
  }
  const triggers = spec.nodes.filter((n) => n.kind === 'trigger')
  if (triggers.length !== 1) errors.push('A workflow needs exactly one trigger.')
  if (!spec.nodes.some((n) => n.kind === 'end')) errors.push('A workflow needs an end step.')
  for (const e of spec.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) errors.push(`An edge points at a missing step (${e.source} → ${e.target}).`)
    else if (e.source === e.target) errors.push(`Step "${e.source}" points at itself.`)
  }
  for (const n of spec.nodes) {
    if (n.kind === 'goto' && (!n.data.targetId || !ids.has(n.data.targetId))) errors.push(`"${n.label}" jumps to a missing step.`)
    if (n.kind === 'agent' && !n.data.agentId) warnings.push(`"${n.label}" has no agent mapped yet.`)
  }
  if (errors.length > 0 || triggers.length !== 1) return { errors, warnings }

  // Everything must be reachable from the trigger, and an end must be reachable.
  const next = new Map<string, string[]>()
  for (const e of spec.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target])
  for (const n of spec.nodes) if (n.kind === 'goto' && n.data.targetId) next.set(n.id, [...(next.get(n.id) ?? []), n.data.targetId])
  const reached = new Set<string>([triggers[0].id])
  const queue = [triggers[0].id]
  while (queue.length) {
    for (const t of next.get(queue.shift() as string) ?? []) {
      if (!reached.has(t)) {
        reached.add(t)
        queue.push(t)
      }
    }
  }
  const orphans = spec.nodes.filter((n) => !reached.has(n.id))
  if (orphans.length) errors.push(`Not reachable from the trigger: ${orphans.map((n) => `"${n.label}"`).join(', ')}.`)
  if (!spec.nodes.some((n) => n.kind === 'end' && reached.has(n.id))) errors.push('No end step is reachable from the trigger.')
  return { errors, warnings }
}
