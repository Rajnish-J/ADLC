// Phase 2 — the canonical internal agent model.
//
// Every heterogeneous on-disk manifest convention (`.claude/agents`, SKILL.md,
// AGENTS.md, agent.yaml, copilot-instructions, .cursor/rules) is normalized by an
// adapter into this single shape. Finalizes the ADR-0001 "schema stub". The field
// set mirrors the harvested orka agent row (name / description / model /
// instructions / content) so Phase 4's compiler can consume it directly.
//
// SECURITY: `raw` holds the original file text for audit only. Discovered content
// is NEVER executed — see src/discovery/scanner.ts.

import type { Suggestion } from './suggestions'

export type SourceKind =
  | 'claude-agent'
  | 'claude-skill'
  | 'agents-md'
  | 'agent-yaml'
  | 'copilot-instructions'
  | 'copilot-agent'
  | 'cursor-rules'

export type AgentStatus = 'valid' | 'skipped' | 'needs-attention'

export interface InternalAgent {
  /** Stable identity: `${sourceKind}:${sourcePath}#${slug(name)}`. */
  id: string
  name: string
  description: string
  /** System prompt / rule body. */
  instructions: string
  /** Tool references, normalized to a string list. */
  tools: string[]
  model?: string
  sourceKind: SourceKind
  /** Workspace-relative POSIX path — clickable in the tree. */
  sourcePath: string
  /** Original file text. For audit only; never executed. */
  raw: string
  status: AgentStatus
  /** Human-readable validation messages → surfaced in the Problems panel. */
  issues: string[]
  /** Advisory quality hints (rule-based) → surfaced in the tree. Set in discover(). */
  suggestions?: Suggestion[]
  /** SKILL.md skills can bundle executable files; flagged for human audit. */
  hasBundledScripts?: boolean
  /** Other source kinds that declared the same agent (set during dedupe). */
  alsoSeenIn?: SourceKind[]
}

/** Human-friendly labels for each source kind (used in the tree headers). */
export const SOURCE_LABELS: Record<SourceKind, string> = {
  'claude-agent': 'Claude Agents (.claude/agents)',
  'claude-skill': 'Claude Skills (SKILL.md)',
  'agents-md': 'AGENTS.md',
  'agent-yaml': 'agent.yaml',
  'copilot-instructions': 'Copilot Instructions',
  'copilot-agent': 'Copilot Agents (.github/agents)',
  'cursor-rules': 'Cursor Rules (.cursor/rules)',
}

/** Skills are reusable capabilities an agent loads; everything else discovered is an agent. */
export function agentKindOf(kind: SourceKind): 'agent' | 'skill' {
  return kind === 'claude-skill' ? 'skill' : 'agent'
}

/** Lowercase, hyphenated slug for stable ids and dedupe keys. */
export function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Build the stable id for an agent. */
export function agentId(sourceKind: SourceKind, sourcePath: string, name: string): string {
  return `${sourceKind}:${sourcePath}#${slug(name) || 'unnamed'}`
}

/**
 * Coerce a heterogeneous `tools` field (string, comma-list, or array) into a
 * clean string[]. Tolerates the many ways conventions express tools.
 */
export function normalizeTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/** Minimal agent data safe to send over postMessage (no secrets). */
export interface AgentSummary {
  id: string
  name: string
  description: string
  model?: string
  sourceKind: string
  instructions: string
  /** Workspace-relative POSIX path the agent is defined in — clickable via revealNode. Absent for
   *  sources with no on-disk manifest (e.g. Azure Foundry agents). */
  sourcePath?: string
  /** SKILL.md skills can bundle executable files; flagged for human audit. */
  hasBundledScripts?: boolean
}
