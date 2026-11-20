// Phase 4 — compiler: InternalAgent[] -> WorkflowSpec.
//
// Maps a discovered/ordered agent set into the version-controllable IR. InternalAgent was designed for this
// (its header notes the field set mirrors the orka agent row). Sequential is the default; handoff adds
// condition-routed edges between agents. Gates are inserted after each agent. Every agent node is
// mandatory human-in-the-loop (plan → approve → execute) — that's intrinsic to AGENT-node execution in
// MockWorkflowRuntime, not something this compiler needs to insert.
// Pure + framework-free (unit-testable, no vscode).

import type { InternalAgent } from '../../discovery/agentModel'
import type { SdlcStep } from '../../eval/sdlcSteps'
import {
  DEFAULT_RUN_BUDGET,
  type RunBudget,
  type SpecEdge,
  type SpecNode,
  type WorkflowPattern,
  type WorkflowSpec,
} from '../spec'

/** A condition-routed handoff: from one agent to another when `predicate` holds. */
export interface HandoffRoute {
  fromAgentIndex: number
  toAgentIndex: number
  /** orka predicate dialect, e.g. `Local.DesignerResult = "FEATURE"`. Empty ⇒ ELSE (fallthrough). */
  predicate: string
}

export interface CompileOptions {
  name: string
  description?: string
  pattern?: WorkflowPattern
  budget?: RunBudget
  /** SDLC step each agent is gated at. Defaults to 'implement'. */
  stepForAgent?: (agent: InternalAgent, index: number) => SdlcStep
  /** Insert a gate after each agent. Default true. */
  gateAfterAgent?: boolean
  /** For 'handoff': explicit condition-routed edges between agents. */
  routes?: HandoffRoute[]
}

/** Canonical id for the variable an agent's response is captured into. */
function outputVarFor(agent: InternalAgent): string {
  const safe = agent.name.replace(/[^A-Za-z0-9]/g, '') || 'Agent'
  return `Local.${safe}Output`
}

export function internalAgentToSpec(agents: InternalAgent[], opts: CompileOptions): WorkflowSpec {
  if (agents.length === 0) {
    throw new Error('Cannot compile a workflow from zero agents.')
  }
  const pattern: WorkflowPattern = opts.pattern ?? 'sequential'
  const gateAfter = opts.gateAfterAgent ?? true
  const stepFor = opts.stepForAgent ?? (() => 'implement' as SdlcStep)

  const nodes: SpecNode[] = []
  const edges: SpecEdge[] = []
  const link = (source: string, target: string) => edges.push({ source, target })

  const triggerId = 'trigger'
  nodes.push({ id: triggerId, kind: 'trigger', label: 'Start', data: {} })

  // The id each agent's "block" entry node is reachable at (always the agent itself — the runtime
  // pauses for plan approval intrinsically before the agent executes).
  const agentEntryId: string[] = []
  // The id control flows out of after each agent's block (its gate if present, else the agent).
  const agentExitId: string[] = []

  agents.forEach((agent, i) => {
    const step = stepFor(agent, i)
    const outputVar = outputVarFor(agent)
    const agentNodeId = `agent_${i}`
    const entryId = agentNodeId

    nodes.push({
      id: agentNodeId,
      kind: 'agent',
      label: agent.name,
      data: { agentId: agent.id, agentName: agent.name, sdlcStep: step, outputVar },
    })

    let exitId = agentNodeId
    if (gateAfter) {
      const gateId = `gate_${i}`
      nodes.push({
        id: gateId,
        kind: 'gate',
        label: `Gate: ${step}`,
        data: { gateStep: step, gateResultVar: `Local.Gate${i}Result` },
      })
      link(agentNodeId, gateId)
      exitId = gateId
    }

    agentEntryId.push(entryId)
    agentExitId.push(exitId)
  })

  const endId = 'end'
  nodes.push({ id: endId, kind: 'end', label: 'Done', data: {} })

  // Trigger → first agent block.
  link(triggerId, agentEntryId[0])

  if (pattern === 'sequential' || !opts.routes || opts.routes.length === 0) {
    // Linear chain: each agent's exit → next agent's entry; last → end.
    for (let i = 0; i < agents.length; i++) {
      const next = i + 1 < agents.length ? agentEntryId[i + 1] : endId
      link(agentExitId[i], next)
    }
  } else {
    // Handoff: emit a condition switch after each agent that has routes; otherwise fall through linearly.
    const routesByFrom = new Map<number, HandoffRoute[]>()
    for (const r of opts.routes) {
      const list = routesByFrom.get(r.fromAgentIndex) ?? []
      list.push(r)
      routesByFrom.set(r.fromAgentIndex, list)
    }

    for (let i = 0; i < agents.length; i++) {
      const routes = routesByFrom.get(i)
      if (!routes || routes.length === 0) {
        // In handoff mode an agent with no outgoing routes is a branch terminal — it ends the run rather
        // than falling through to the next declared agent (which is typically a sibling branch target).
        link(agentExitId[i], endId)
        continue
      }
      // One condition node per route; precedence IF, ELSE_IF…, with a final ELSE → end if none has empty pred.
      const ordered = [...routes]
      const hasElse = ordered.some((r) => r.predicate.trim() === '')
      ordered.forEach((route, j) => {
        const condId = `cond_${i}_${j}`
        const branch = route.predicate.trim() === '' ? 'ELSE' : j === 0 ? 'IF' : 'ELSE_IF'
        nodes.push({
          id: condId,
          kind: 'condition',
          label: `Route ${i}→${route.toAgentIndex}`,
          data: { predicate: route.predicate, branch },
        })
        link(agentExitId[i], condId)
        link(condId, agentEntryId[route.toAgentIndex])
      })
      if (!hasElse) {
        const elseId = `cond_${i}_else`
        nodes.push({ id: elseId, kind: 'condition', label: `Route ${i}→end`, data: { branch: 'ELSE' } })
        link(agentExitId[i], elseId)
        link(elseId, endId)
      }
    }
  }

  return {
    specVersion: 1,
    name: opts.name,
    description: opts.description ?? '',
    pattern,
    nodes,
    edges,
    budget: opts.budget ?? DEFAULT_RUN_BUDGET,
  }
}
