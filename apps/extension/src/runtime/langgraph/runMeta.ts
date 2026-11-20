// The metadata LangGraphWorkflowRuntime needs to recompile a run's StateGraph after a restart (the
// checkpointer stores channel state, but recompiling node functions needs the original spec/budget/actor).
// Kept free of `vscode` so the runtime can be hosted outside the extension; RunMetaStore (extension) and a
// database-backed store (backend) both persist this shape.

import type { RunBudget, WorkflowSpec } from '../spec'

export interface RunMeta {
  spec: WorkflowSpec
  budget: RunBudget
  actor: string
  workflowName: string
  inputs: Record<string, unknown>
  startedAt: number
}
