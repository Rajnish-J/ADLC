// Builds a "base" SDLC WorkflowSpec from the real discovered agents.
//
// Pure + framework-free (no vscode) so it's unit-testable and reusable from commands. Agents are
// bucketed into SDLC phases by name keyword, ordered Requirements → Design → Build → Review → Test →
// Security → Release → Docs, then chained: issue trigger → agent → … → end. Every agent node carries
// its real agentId so the chat resolver (LmAgentDispatcher) can run it through Copilot.

import type { WorkflowSpec, SpecNode, SpecEdge } from './spec'
import type { SdlcStep } from '../eval/sdlcSteps'
import { DEFAULT_RUN_BUDGET } from './spec'

/** Minimal agent shape the builder needs (matches InternalAgent / AgentSummary). */
export interface BaseAgentInput {
  id: string
  name: string
}

export interface BaseWorkflowOptions {
  /** Workflow name (defaults to "SDLC Base Workflow"). */
  name?: string
  adoOrg?: string
  adoProject?: string
  /** Work-item type the issue trigger lists (defaults to "User Story"). */
  workItemType?: string
}

/** Ordered SDLC phases with the keywords that route an agent into each and the step they gate at. */
const PHASES: { test: RegExp; step: SdlcStep }[] = [
  { test: /requirement|analyst|\bbrd\b|intake|gap|story/i, step: 'design' },
  { test: /architect|\bhld\b|design|\badr\b|schema|contract|spike|api contract/i, step: 'design' },
  { test: /scaffold|component|route|api|form|service|integrat|generat|implement|build|coder?\b/i, step: 'implement' },
  { test: /review|\bpr\b/i, step: 'review' },
  { test: /test|coverage|e2e|\bqa\b|quality/i, step: 'review' },
  { test: /security|vuln|secret/i, step: 'review' },
  { test: /deploy|release|pipeline|rollback|ship|notifier/i, step: 'release' },
  { test: /\bdoc|readme|stakeholder|report/i, step: 'release' },
]

/** Bucket index for an agent name (PHASES.length = "unmatched", appended last). */
function phaseFor(name: string): number {
  const idx = PHASES.findIndex((p) => p.test.test(name))
  return idx === -1 ? PHASES.length : idx
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Build a sequential SDLC base workflow from the given agents. */
export function buildBaseWorkflow(agents: BaseAgentInput[], opts: BaseWorkflowOptions = {}): WorkflowSpec {
  const name = opts.name?.trim() || 'SDLC Base Workflow'

  // Stable sort by SDLC phase, preserving discovery order within a phase.
  const ordered = agents
    .map((a, i) => ({ a, i, phase: phaseFor(a.name) }))
    .sort((x, y) => x.phase - y.phase || x.i - y.i)

  const agentNodes: SpecNode[] = ordered.map(({ a, phase }, i) => {
    const step: SdlcStep = phase < PHASES.length ? PHASES[phase].step : 'implement'
    return {
      id: `agent-${i}-${sanitize(a.id)}`.slice(0, 80),
      kind: 'agent',
      label: a.name,
      data: {
        agentId: a.id,
        agentName: a.name,
        sdlcStep: step,
        outputVar: `Local.${sanitize(a.name).replace(/-/g, '') || `Agent${i}`}Result`,
      },
    }
  })

  const trigger: SpecNode = {
    id: 'trigger',
    kind: 'trigger',
    label: 'User Story Trigger',
    data: {
      triggerType: 'issue',
      issueSource: 'azure-devops',
      workItemType: opts.workItemType?.trim() || 'User Story',
      ...(opts.adoOrg ? { adoOrg: opts.adoOrg } : {}),
      ...(opts.adoProject ? { adoProject: opts.adoProject } : {}),
    },
  }
  const end: SpecNode = { id: 'end', kind: 'end', label: 'Done', data: {} }

  const sequence = [trigger.id, ...agentNodes.map((n) => n.id), end.id]
  const edges: SpecEdge[] = sequence.slice(0, -1).map((source, i) => ({ source, target: sequence[i + 1] }))

  return {
    specVersion: 1,
    name,
    description: 'Base SDLC pipeline generated from your discovered agents. Start fetches your assigned Azure DevOps user stories and runs each agent through Copilot.',
    pattern: 'sequential',
    budget: DEFAULT_RUN_BUDGET,
    nodes: [trigger, ...agentNodes, end],
    edges,
  }
}
