// The agent catalog of one project: built-ins (projectId null), the project's repo-discovered agents and skills,
// and its PLATFORM agents and skills (source `platform`). Served by the orchestrator service
// (services/orchestrator/app/catalog/agents.py); this module keeps the exports and signatures the routes and the chat
// assistant's tools call, and rethrows the orchestrator's errors as the same HttpErrors.

import { eq, isNull, or } from 'drizzle-orm'
import {
  AgentDetailSchema,
  AgentSchema,
  canUseAgent,
  type Agent,
  type AgentDetail,
  type CreatePlatformAgentInput,
  type UpdatePlatformAgentInput,
} from '@sdlc/contracts'
import { z } from 'zod'
import type { ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import { agents } from '../db/schema'
import { orchestrator, projectPath } from '../orchestrator/client'
import type { Caller, ServiceDeps } from './context'

export type AgentRow = typeof agents.$inferSelect

/** Built-ins plus this project's own agents and skills (repo-discovered and platform-defined). */
export const visibleAgents = (projectId: string) => or(isNull(agents.projectId), eq(agents.projectId, projectId))

/** An agent row as the API shows it. */
export function toAgent(access: ProjectAccess, agent: AgentRow, enabled: boolean | null): Agent {
  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    category: agent.category,
    sdlcStage: agent.sdlcStage,
    executionTarget: agent.executionTarget,
    tools: agent.tools,
    // A catalog agent added after the project was created stays off until someone enables it.
    enabled: enabled ?? false,
    source: agent.source,
    kind: agent.kind,
    branch: agent.branch,
    requiredRole: agent.minProjectRole,
    usable: canUseAgent(access.actor, access.role, agent),
    sourcePath: agent.sourcePath,
    model: agent.model,
    issues: agent.issues,
  }
}

const ToggledSchema = z.object({ slug: z.string(), enabled: z.boolean() })
const OkSchema = z.object({ ok: z.literal(true) })

export async function listAgents(_db: Db, user: AuthUser, key: string): Promise<Agent[]> {
  return orchestrator().call({ user }, 'GET', projectPath(key, 'agents'), z.array(AgentSchema))
}

export async function getAgent(_db: Db, user: AuthUser, key: string, slug: string): Promise<AgentDetail> {
  return orchestrator().call({ user }, 'GET', projectPath(key, 'agents', slug), AgentDetailSchema)
}

export async function setAgentEnabled(
  _deps: ServiceDeps,
  caller: Caller,
  key: string,
  slug: string,
  enabled: boolean,
): Promise<{ slug: string; enabled: boolean }> {
  return orchestrator().call(caller, 'PUT', projectPath(key, 'agents', slug), ToggledSchema, { body: { enabled } })
}

export async function createPlatformAgent(_deps: ServiceDeps, caller: Caller, key: string, raw: CreatePlatformAgentInput): Promise<AgentDetail> {
  return orchestrator().call(caller, 'POST', projectPath(key, 'agents'), AgentDetailSchema, { body: raw })
}

export async function updatePlatformAgent(
  _deps: ServiceDeps,
  caller: Caller,
  key: string,
  slug: string,
  raw: UpdatePlatformAgentInput,
): Promise<AgentDetail> {
  return orchestrator().call(caller, 'PATCH', projectPath(key, 'agents', slug), AgentDetailSchema, { body: raw })
}

export async function deletePlatformAgent(_deps: ServiceDeps, caller: Caller, key: string, slug: string): Promise<{ ok: true }> {
  return orchestrator().call(caller, 'DELETE', projectPath(key, 'agents', slug), OkSchema)
}

