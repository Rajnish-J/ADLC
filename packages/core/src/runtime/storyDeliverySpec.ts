// "Story delivery" — the default workflow, shared by the platform (seeded into every project) and the VS Code
// extension (its read-only local default). It lays out the stages every story goes through
// (plan → approval → implement → test → gate → review → PR → merge approval), each agent step bound by slug
// (`agentId`) to a built-in agent from ../../agents/*.md. Projects remap steps to their own agents; local users
// duplicate it. Plan and Implement plan first and wait for a person's approval; Test, Review and PR description
// execute straight away (`requirePlanApproval: false`) — the gate and the two approval nodes cover them.

import { DEFAULT_RUN_BUDGET, type SpecNode, type WorkflowSpec } from './spec'

/** Local id of the read-only default in the extension's workflow store. */
export const STORY_DELIVERY_ID = 'story-delivery'

const nodes: SpecNode[] = [
  { id: 'story-picked-up', kind: 'trigger', label: 'Story picked up', data: { triggerType: 'manual' } },
  { id: 'plan', kind: 'agent', label: 'Plan', data: { agentId: 'planner', agentName: 'Planner' } },
  {
    id: 'approve-plan',
    kind: 'approval',
    label: 'Approve plan',
    data: { question: 'Does the plan cover every acceptance criterion?' },
  },
  { id: 'implement', kind: 'agent', label: 'Implement', data: { agentId: 'implementer', agentName: 'Implementer' } },
  { id: 'test', kind: 'agent', label: 'Test', data: { agentId: 'tester', agentName: 'Tester', requirePlanApproval: false } },
  { id: 'quality-gate', kind: 'gate', label: 'Quality gate', data: {} },
  { id: 'review', kind: 'agent', label: 'Review', data: { agentId: 'reviewer', agentName: 'Reviewer', requirePlanApproval: false } },
  {
    id: 'pr-description',
    kind: 'agent',
    label: 'PR description',
    data: { agentId: 'pr-author', agentName: 'PR Author', requirePlanApproval: false },
  },
  { id: 'merge-approval', kind: 'approval', label: 'Merge approval', data: { question: 'Ready to merge?' } },
  { id: 'done', kind: 'end', label: 'Done', data: {} },
]

export const STORY_DELIVERY_SPEC: WorkflowSpec = {
  specVersion: 1,
  name: 'Story delivery',
  description: 'The stages every story goes through, each agent step bound to a built-in agent. Duplicate it to map your own agents.',
  pattern: 'sequential',
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id })),
  budget: DEFAULT_RUN_BUDGET,
}
