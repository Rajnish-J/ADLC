import { z } from 'zod'
import {
  AgentDetailSchema,
  AgentSchema,
  AuditEntrySchema,
  SetStepAgentResultSchema,
  SetStepHarnessResultSchema,
  WorkflowSummarySchema,
  type Agent,
  type AgentDetail,
  type AuditEntry,
  type CreatePlatformAgentInput,
  type CreateWorkflowInput,
  type SetStepAgentResult,
  type SetStepHarnessResult,
  type UpdatePlatformAgentInput,
  type UpdateWorkflowInput,
  type WorkflowSummary,
} from '@sdlc/contracts'
import { WorkflowDetailSchema, type WorkflowDetail } from '@/types/workflow/workflow.types'
import { apiCommand, apiRequest } from './http'

const projectPath = (key: string): string => `/projects/${encodeURIComponent(key)}`

export function listAgents(key: string): Promise<Agent[]> {
  return apiRequest(`${projectPath(key)}/agents`, z.array(AgentSchema))
}

export function getAgent(key: string, slug: string): Promise<AgentDetail> {
  return apiRequest(`${projectPath(key)}/agents/${encodeURIComponent(slug)}`, AgentDetailSchema)
}

export function setAgentEnabled(key: string, slug: string, enabled: boolean): Promise<void> {
  return apiCommand(`${projectPath(key)}/agents/${encodeURIComponent(slug)}`, { method: 'PUT', body: { enabled } })
}

/** Create a platform agent or skill in the project (it starts enabled). */
export function createAgent(key: string, input: CreatePlatformAgentInput): Promise<AgentDetail> {
  return apiRequest(`${projectPath(key)}/agents`, AgentDetailSchema, { method: 'POST', body: input })
}

/** Edit a platform agent or skill's definition (built-in and repo agents are read-only). */
export function updateAgent(key: string, slug: string, input: UpdatePlatformAgentInput): Promise<AgentDetail> {
  return apiRequest(`${projectPath(key)}/agents/${encodeURIComponent(slug)}`, AgentDetailSchema, { method: 'PATCH', body: input })
}

export function listWorkflows(key: string): Promise<WorkflowSummary[]> {
  return apiRequest(`${projectPath(key)}/workflows`, z.array(WorkflowSummarySchema))
}

export function getWorkflow(key: string, id: string): Promise<WorkflowDetail> {
  return apiRequest(`${projectPath(key)}/workflows/${id}`, WorkflowDetailSchema)
}

export function createWorkflow(key: string, input: CreateWorkflowInput): Promise<WorkflowDetail> {
  return apiRequest(`${projectPath(key)}/workflows`, WorkflowDetailSchema, { method: 'POST', body: input })
}

/** Save a whole workflow. `version` is the one the edit started from; a stale one is rejected with 409. */
export function updateWorkflow(key: string, id: string, input: UpdateWorkflowInput): Promise<WorkflowDetail> {
  return apiRequest(`${projectPath(key)}/workflows/${id}`, WorkflowDetailSchema, { method: 'PATCH', body: input })
}

export function setDefaultWorkflow(key: string, id: string): Promise<WorkflowSummary> {
  return apiRequest(`${projectPath(key)}/workflows/${id}/default`, WorkflowSummarySchema, { method: 'POST' })
}

/** Refused (409) for the default workflow and for one with active runs. */
export function deleteWorkflow(key: string, id: string): Promise<void> {
  return apiCommand(`${projectPath(key)}/workflows/${id}`, { method: 'DELETE' })
}

/** Map an agent onto one agent step of a workflow; null leaves the step without an agent. */
export function setStepAgent(key: string, workflowId: string, nodeId: string, agentSlug: string | null): Promise<SetStepAgentResult> {
  return apiRequest(
    `${projectPath(key)}/workflows/${workflowId}/nodes/${encodeURIComponent(nodeId)}/agent`,
    SetStepAgentResultSchema,
    { method: 'PUT', body: { agentSlug } },
  )
}

/** Pin an agent step to a harness; null runs it in the harness picked when the run starts. */
export function setStepHarness(key: string, workflowId: string, nodeId: string, harness: string | null): Promise<SetStepHarnessResult> {
  return apiRequest(
    `${projectPath(key)}/workflows/${workflowId}/nodes/${encodeURIComponent(nodeId)}/harness`,
    SetStepHarnessResultSchema,
    { method: 'PUT', body: { harness } },
  )
}

export function listActivity(key: string): Promise<AuditEntry[]> {
  return apiRequest(`${projectPath(key)}/audit`, z.array(AuditEntrySchema))
}
