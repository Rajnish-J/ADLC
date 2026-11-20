// Source Azure Foundry-registered agents for the workflow builder and the run-time resolver.
//
// Foundry agents live in a project's data plane (name + version + optional instructions/model), not on
// disk. This module fetches them via the Control Plane client and adapts them into the two shapes the
// rest of the extension already understands:
//   • AgentSummary       — sent over postMessage to the builder's Add Agent modal (azure_foundry tab)
//   • InternalAgent-like  — consumed by LmAgentDispatcher at run time (only reads instructions + model)
//
// All network access degrades gracefully: any failure (no project, RBAC, backend unavailable) returns
// an empty list rather than throwing, mirroring controlPlaneProvider.load(). The id format encodes the
// project endpoint + name@version so nodes round-trip and the run-time resolver can match by id.

import type { TokenProvider } from './foundryClient'
import { listAllAccessibleProjects } from './foundryClient'
import { ControlPlaneClient, type RegisteredAgent } from './controlPlane'
import type { AgentSummary, InternalAgent } from '../discovery/agentModel'

/** A Foundry-sourced agent, normalized to the fields the extension uses. */
export interface FoundryAgent {
  /** Stable id: `azure_foundry:<projectEndpoint>#<name>@<version>`. */
  id: string
  name: string
  description: string
  instructions: string
  model?: string
  version: string
}

/** Build the stable id for a Foundry agent. */
export function foundryAgentId(projectEndpoint: string, name: string, version: string): string {
  return `azure_foundry:${projectEndpoint.replace(/\/+$/, '')}#${name}@${version}`
}

function toFoundryAgent(projectEndpoint: string, a: RegisteredAgent): FoundryAgent {
  return {
    id: foundryAgentId(projectEndpoint, a.name, a.version),
    name: a.name,
    description: a.description ?? '',
    instructions: a.instructions ?? '',
    model: a.model,
    version: a.version,
  }
}

/**
 * List every Foundry-registered agent the signed-in identity can see, from the first accessible
 * project. Returns [] on any failure (no project / auth / backend) — never throws.
 */
export async function listFoundryAgents(getToken: TokenProvider): Promise<FoundryAgent[]> {
  try {
    const projects = await listAllAccessibleProjects(getToken)
    if (projects.length === 0) return []
    const endpoint = projects[0].projectEndpoint
    const client = new ControlPlaneClient(endpoint, getToken)
    const agents = await client.listAgents()
    return agents.map((a) => toFoundryAgent(endpoint, a))
  } catch {
    return []
  }
}

/** Adapt a Foundry agent to the postMessage-safe summary shown in the Add Agent modal. */
export function toAgentSummary(fa: FoundryAgent): AgentSummary {
  return {
    id: fa.id,
    name: fa.name,
    description: fa.description,
    model: fa.model,
    sourceKind: 'azure_foundry',
    instructions: fa.instructions,
  }
}

/**
 * Adapt a Foundry agent to a minimal InternalAgent so LmAgentDispatcher can resolve it at run time.
 * The dispatcher only reads `instructions` and `model`; the remaining fields are filled with safe
 * placeholders (Foundry agents have no on-disk manifest).
 */
export function toInternalAgentLike(fa: FoundryAgent): InternalAgent {
  return {
    id: fa.id,
    name: fa.name,
    description: fa.description,
    instructions: fa.instructions,
    tools: [],
    model: fa.model,
    sourceKind: 'agent-yaml',
    sourcePath: '',
    raw: '',
    status: 'valid',
    issues: [],
  }
}
