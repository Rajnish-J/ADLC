// Skills on a workflow step — served by the orchestrator service (services/orchestrator/app/catalog/workflows.py).
// Besides its one agent, an agent step may list catalog skills the agent can use while it works; when a run starts,
// the extension materializes them for the step's harness and the run records which ones were actually used.

import { SetStepSkillsResultSchema, type SetStepSkillsInput, type SetStepSkillsResult } from '@sdlc/contracts'
import { orchestrator, projectPath } from '../orchestrator/client'
import type { Caller, ServiceDeps } from './context'

export async function setStepSkills(
  _deps: ServiceDeps,
  caller: Caller,
  key: string,
  workflowId: string,
  nodeId: string,
  input: SetStepSkillsInput,
): Promise<SetStepSkillsResult> {
  return orchestrator().call(caller, 'PUT', projectPath(key, 'workflows', workflowId, 'nodes', nodeId, 'skills'), SetStepSkillsResultSchema, {
    body: input,
  })
}
