// Pure WorkflowSpec factory helpers — framework-free, usable from both host and webview.

import type { WorkflowSpec } from './spec'
import { DEFAULT_RUN_BUDGET } from './spec'

/** Create a minimal blank WorkflowSpec with a trigger and end node. */
export function blankSpec(name: string): WorkflowSpec {
  return {
    specVersion: 1,
    name,
    description: '',
    pattern: 'sequential',
    budget: DEFAULT_RUN_BUDGET,
    nodes: [
      { id: 'trigger', kind: 'trigger', label: 'Start', data: {} },
      { id: 'end', kind: 'end', label: 'Done', data: {} },
    ],
    edges: [{ source: 'trigger', target: 'end' }],
  }
}
