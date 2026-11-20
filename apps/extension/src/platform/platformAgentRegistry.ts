// Platform agents a project workflow binds by slug ("planner", "implementer"…). Their instructions live on the
// SDLC platform, not in this workspace, so before a project workflow runs here its agents are fetched and
// registered; the dispatcher's resolver falls back to this registry after discovered and Foundry agents.
// Discovered ids are `<sourceKind>:<path>#<slug>`, so a bare platform slug can never shadow one.
//
// The registry is also kept in globalState (see usePlatformAgentStore): a run restored after a window reload
// resumes without anyone re-fetching its agents, and must still resolve them.

import type { AgentDetail } from '@sdlc/contracts'
import type { InternalAgent } from '../discovery/agentModel'

const STORE_KEY = 'sdlcGovernance.platformAgents'

/** The slice of a Memento the registry needs (globalState in the extension; a fake in tests). */
export interface AgentMemento {
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): Thenable<void>
}

const registry = new Map<string, InternalAgent>()
let store: AgentMemento | undefined

export function toInternalAgent(agent: AgentDetail): InternalAgent {
  return {
    id: agent.slug,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    tools: agent.tools,
    // Same convention Foundry agents use (foundryAgents.toInternalAgentLike): a non-file source.
    sourceKind: 'agent-yaml',
    sourcePath: agent.sourcePath ?? '',
    raw: '',
    status: 'valid',
    issues: [],
  }
}

/** Load the agents saved by earlier sessions, and save every later registration. Call once on activation. */
export function usePlatformAgentStore(memento: AgentMemento): void {
  store = memento
  for (const agent of memento.get<InternalAgent[]>(STORE_KEY, [])) {
    if (!registry.has(agent.id)) registry.set(agent.id, agent)
  }
}

export function registerPlatformAgents(agents: AgentDetail[]): void {
  for (const a of agents) registry.set(a.slug, toInternalAgent(a))
  void store?.update(STORE_KEY, [...registry.values()])
}

export function lookupPlatformAgent(id: string): InternalAgent | undefined {
  return registry.get(id)
}
