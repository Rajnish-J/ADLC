// Phase 5B — Foundry Control Plane client.
//
// Fleet visibility + guardrail governance over the new Foundry projects data plane: list registered
// agents (name+version), list guardrail policies, evaluate compliance, and remediate non-compliant
// agents. The compliance engine is PURE + unit-tested; the HTTP calls degrade gracefully because the
// server-side Foundry backend is still an unresolved Phase-4 spike (Unknown A) — a call that 404s /
// errors surfaces as `available: false`, never a silent empty fleet. Re-verify endpoint paths against
// the latest Foundry data-plane API before depending on them. See plan §5B.

import { FOUNDRY_DATA_API, FOUNDRY_SCOPE } from './constants'
import type { TokenProvider } from './foundryClient'

/** An agent registered in a Foundry project (new API identity = name + version). */
export interface RegisteredAgent {
  name: string
  version: string
  /** Guardrails currently applied to this agent (e.g. content-safety, pii-redaction). */
  appliedGuardrails: string[]
  /** Optional human description from the assistant definition. */
  description?: string
  /** System prompt / instructions from the assistant definition (used to run the agent via Copilot). */
  instructions?: string
  /** Model the agent was authored against (a hint for model selection). */
  model?: string
}

/** A versioned guardrail policy: the guardrails every governed agent must have applied. */
export interface GuardrailPolicy {
  id: string
  name: string
  version: string
  requiredGuardrails: string[]
}

/** Per-agent compliance verdict against a policy. */
export interface AgentCompliance {
  agent: RegisteredAgent
  compliant: boolean
  /** Required guardrails the agent is missing (empty when compliant). */
  missing: string[]
}

/**
 * Pure: evaluate each agent against a policy. An agent is non-compliant if it is missing any guardrail
 * the policy requires. Deterministic and dependency-free — the testable heart of 5B.
 */
export function evaluateCompliance(
  agents: RegisteredAgent[],
  policy: GuardrailPolicy,
): AgentCompliance[] {
  return agents.map((agent) => {
    const applied = new Set(agent.appliedGuardrails)
    const missing = policy.requiredGuardrails.filter((g) => !applied.has(g))
    return { agent, compliant: missing.length === 0, missing }
  })
}

/** Raised when the Foundry server-side backend isn't reachable (Unknown A unresolved / RBAC / 404). */
export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendUnavailableError'
  }
}

/** What a fleet fetch returns — either live data, or an explicit unavailable signal with a reason. */
export type FleetResult =
  | { available: true; agents: RegisteredAgent[]; policies: GuardrailPolicy[] }
  | { available: false; reason: string }

async function dataPlaneGet<T>(endpoint: string, path: string, token: string): Promise<T> {
  const url = `${endpoint.replace(/\/+$/, '')}/${path}?api-version=${FOUNDRY_DATA_API}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const sanitised = text.replace(/(eyJ[\w-]{20,})/g, '<token-redacted>')
    throw new BackendUnavailableError(
      `Control Plane request failed (${res.status}): ${sanitised.slice(0, 300) || res.statusText}`,
    )
  }
  const raw = await res.text()
  return (raw ? JSON.parse(raw) : {}) as T
}

export class ControlPlaneClient {
  constructor(
    private readonly projectEndpoint: string,
    private readonly getToken: TokenProvider,
  ) {}

  /** List registered agents. Throws BackendUnavailableError when the data plane is unreachable. */
  async listAgents(): Promise<RegisteredAgent[]> {
    const token = await this.getToken(FOUNDRY_SCOPE)
    type Resp = {
      value?: Array<{
        name: string
        version?: string
        guardrails?: string[]
        description?: string
        instructions?: string
        model?: string
      }>
    }
    const data = await dataPlaneGet<Resp>(this.projectEndpoint, 'agents', token)
    return (data.value ?? []).map((a) => ({
      name: a.name,
      version: a.version ?? '1',
      appliedGuardrails: a.guardrails ?? [],
      description: a.description,
      instructions: a.instructions,
      model: a.model,
    }))
  }

  /** List guardrail policies configured for the project. */
  async listPolicies(): Promise<GuardrailPolicy[]> {
    const token = await this.getToken(FOUNDRY_SCOPE)
    type Resp = {
      value?: Array<{ id: string; name: string; version?: string; requiredGuardrails?: string[] }>
    }
    const data = await dataPlaneGet<Resp>(this.projectEndpoint, 'guardrailPolicies', token)
    return (data.value ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version ?? '1',
      requiredGuardrails: p.requiredGuardrails ?? [],
    }))
  }

  /** Fetch the whole fleet, degrading to an explicit unavailable result on any backend failure. */
  async fetchFleet(): Promise<FleetResult> {
    try {
      const [agents, policies] = await Promise.all([this.listAgents(), this.listPolicies()])
      return { available: true, agents, policies }
    } catch (err) {
      const reason =
        err instanceof BackendUnavailableError
          ? err.message
          : `Control Plane unavailable: ${err instanceof Error ? err.message : String(err)}`
      return { available: false, reason }
    }
  }

  /** Apply the policy's required guardrails to one agent (remediation). */
  async remediateAgent(agent: RegisteredAgent, policy: GuardrailPolicy): Promise<void> {
    const token = await this.getToken(FOUNDRY_SCOPE)
    const url =
      `${this.projectEndpoint.replace(/\/+$/, '')}/agents/${encodeURIComponent(agent.name)}` +
      `/versions/${encodeURIComponent(agent.version)}/guardrails?api-version=${FOUNDRY_DATA_API}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ guardrails: policy.requiredGuardrails }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new BackendUnavailableError(
        `Remediation failed for ${agent.name} v${agent.version} (${res.status}): ${
          text.slice(0, 200) || res.statusText
        }`,
      )
    }
  }
}
