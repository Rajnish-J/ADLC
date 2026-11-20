// Project workflows — served by the orchestrator service (services/orchestrator/app/catalog/workflows.py), which
// validates every spec (validateWorkflowSpec) and every agent/skill/harness it binds. This module keeps the same
// exports and signatures the routes and the chat assistant's tools call, and rethrows the orchestrator's errors as
// the same HttpErrors (status, code and message) the in-process implementation used to throw.

import { z } from 'zod'
import {
  SetStepAgentResultSchema,
  SetStepHarnessResultSchema,
  WorkflowSummarySchema,
  type CreateWorkflowInput,
  type SetStepAgentInput,
  type SetStepAgentResult,
  type SetStepHarnessInput,
  type SetStepHarnessResult,
  type UpdateWorkflowInput,
  type WorkflowDetail,
  type WorkflowSummary,
} from '@sdlc/contracts'
import type { WorkflowSpec } from '@sdlc/core'
import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import { orchestrator, projectPath } from '../orchestrator/client'
import type { Caller, ServiceDeps } from './context'

const WorkflowDetailSchema = WorkflowSummarySchema.extend({
  spec: z.custom<WorkflowSpec>((v) => !!v && typeof v === 'object' && Array.isArray((v as WorkflowSpec).nodes)),
})
const OkSchema = z.object({ ok: z.literal(true) })

export async function listWorkflows(_db: Db, user: AuthUser, key: string): Promise<WorkflowSummary[]> {
  return orchestrator().call({ user }, 'GET', projectPath(key, 'workflows'), z.array(WorkflowSummarySchema))
}

export async function getWorkflow(_db: Db, user: AuthUser, key: string, id: string): Promise<WorkflowDetail> {
  return orchestrator().call({ user }, 'GET', projectPath(key, 'workflows', id), WorkflowDetailSchema)
}

export async function createWorkflow(_deps: ServiceDeps, caller: Caller, key: string, raw: CreateWorkflowInput): Promise<WorkflowDetail> {
  return orchestrator().call(caller, 'POST', projectPath(key, 'workflows'), WorkflowDetailSchema, { body: raw })
}

export async function updateWorkflow(_deps: ServiceDeps, caller: Caller, key: string, id: string, raw: UpdateWorkflowInput): Promise<WorkflowDetail> {
  return orchestrator().call(caller, 'PATCH', projectPath(key, 'workflows', id), WorkflowDetailSchema, { body: raw })
}

export async function setDefaultWorkflow(_deps: ServiceDeps, caller: Caller, key: string, id: string): Promise<WorkflowSummary> {
  return orchestrator().call(caller, 'POST', projectPath(key, 'workflows', id, 'default'), WorkflowSummarySchema)
}

export async function deleteWorkflow(_deps: ServiceDeps, caller: Caller, key: string, id: string): Promise<{ ok: true }> {
  return orchestrator().call(caller, 'DELETE', projectPath(key, 'workflows', id), OkSchema)
}

/** Map an agent onto one agent step of a project workflow (null unbinds it). */
export async function setStepAgent(
  _deps: ServiceDeps,
  caller: Caller,
  key: string,
  id: string,
  nodeId: string,
  raw: SetStepAgentInput,
): Promise<SetStepAgentResult> {
  return orchestrator().call(caller, 'PUT', projectPath(key, 'workflows', id, 'nodes', nodeId, 'agent'), SetStepAgentResultSchema, {
    body: raw,
  })
}

/** Pin an agent step to a harness (null = the harness the run is started with). */
export async function setStepHarness(
  _deps: ServiceDeps,
  caller: Caller,
  key: string,
  id: string,
  nodeId: string,
  raw: SetStepHarnessInput,
): Promise<SetStepHarnessResult> {
  return orchestrator().call(caller, 'PUT', projectPath(key, 'workflows', id, 'nodes', nodeId, 'harness'), SetStepHarnessResultSchema, {
    body: raw,
  })
}
