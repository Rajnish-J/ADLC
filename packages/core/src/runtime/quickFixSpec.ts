// "Quick fix" — the light workflow a run started from a prompt (no story) uses by default: implement the fix, then
// review it. Seeded into every project next to "Story delivery"; its agent steps bind the same built-in agents by
// slug, so projects can remap them like any other workflow.

import { DEFAULT_RUN_BUDGET, type SpecNode, type WorkflowSpec } from './spec'

export const QUICK_FIX_WORKFLOW_NAME = 'Quick fix'

const nodes: SpecNode[] = [
  { id: 'prompt', kind: 'trigger', label: 'Prompt', data: { triggerType: 'manual' } },
  { id: 'implement', kind: 'agent', label: 'Implement', data: { agentId: 'implementer', agentName: 'Implementer' } },
  { id: 'review', kind: 'agent', label: 'Review', data: { agentId: 'reviewer', agentName: 'Reviewer' } },
  { id: 'done', kind: 'end', label: 'Done', data: {} },
]

export const QUICK_FIX_SPEC: WorkflowSpec = {
  specVersion: 1,
  name: QUICK_FIX_WORKFLOW_NAME,
  description: 'For a quick fix described in a prompt: implement it, then review it. No story needed.',
  pattern: 'sequential',
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id })),
  budget: DEFAULT_RUN_BUDGET,
}
