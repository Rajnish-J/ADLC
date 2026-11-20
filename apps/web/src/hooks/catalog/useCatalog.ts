'use client'

import type { Agent, AgentDetail, AuditEntry, WorkflowSummary } from '@sdlc/contracts'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { auditedChange } from '@/hooks/common/liveFilters'
import { getAgent, getWorkflow, listActivity, listAgents, listWorkflows } from '@/service/catalog.service'
import type { WorkflowDetail } from '@/types/workflow/workflow.types'

export function useAgents(key: string): ApiResource<Agent[]> {
  return useApiResource(() => listAgents(key), [key], (e) => e.type === 'project.changed' && e.projectKey === key)
}

export function useAgent(key: string, slug: string): ApiResource<AgentDetail> {
  return useApiResource(() => getAgent(key, slug), [key, slug], (e) => e.type === 'project.changed' && e.projectKey === key)
}

export function useWorkflows(key: string): ApiResource<WorkflowSummary[]> {
  return useApiResource(() => listWorkflows(key), [key], (e) => e.type === 'project.changed' && e.projectKey === key)
}

export function useWorkflow(key: string, id: string | null): ApiResource<WorkflowDetail | null> {
  return useApiResource(() => (id ? getWorkflow(key, id) : Promise.resolve(null)), [key, id], (e) => e.type === 'project.changed' && e.projectKey === key)
}

export function useActivity(key: string): ApiResource<AuditEntry[]> {
  return useApiResource(() => listActivity(key), [key], auditedChange(key))
}

/** Where an agent is mapped: "<workflow> › <step>" for every agent step bound to it, across the project's workflows. */
export type StepMappings = Map<string, string[]>

export function useStepMappings(key: string): ApiResource<StepMappings> {
  return useApiResource(
    async () => {
      const details = await Promise.all((await listWorkflows(key)).map((w) => getWorkflow(key, w.id)))
      const map: StepMappings = new Map()
      for (const w of details) {
        for (const n of w.spec.nodes) {
          if (n.kind !== 'agent' || !n.data.agentId) continue
          map.set(n.data.agentId, [...(map.get(n.data.agentId) ?? []), `${w.name} › ${n.label}`])
        }
      }
      return map
    },
    [key],
    (e) => e.type === 'project.changed' && e.projectKey === key,
  )
}

/** Every workflow of the project with its spec — the default first, then by name. */
export function useWorkflowDetails(key: string): ApiResource<WorkflowDetail[]> {
  return useApiResource(
    async () => {
      const list = await listWorkflows(key)
      const details = await Promise.all(list.map((w) => getWorkflow(key, w.id)))
      return details.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
    },
    [key],
    (e) => e.type === 'project.changed' && e.projectKey === key,
  )
}
