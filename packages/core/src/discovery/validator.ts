// Validation + agent construction.
//
// Centralizes how a raw parse result becomes an InternalAgent with a status:
//   • skipped         — the file couldn't be parsed (e.g. malformed YAML).
//   • needs-attention — parsed, but a required field is missing/empty.
//   • valid           — has at least a name + some instructions.
// Issues are human-readable and flow to the Problems panel via diagnostics.ts.
// Pure — no `vscode`, no I/O.

import {
  agentId,
  type AgentStatus,
  type InternalAgent,
  type SourceKind,
} from './agentModel'

export interface AgentDraft {
  sourceKind: SourceKind
  sourcePath: string
  raw: string
  name: string
  description: string
  instructions: string
  tools: string[]
  model?: string
  /** Set by an adapter when the file's metadata block failed to parse. */
  malformed?: boolean
  hasBundledScripts?: boolean
}

/** Construct a validated InternalAgent from an adapter's parse result. */
export function buildAgent(draft: AgentDraft): InternalAgent {
  const issues: string[] = []
  let status: AgentStatus = 'valid'

  if (draft.malformed) {
    issues.push('Manifest metadata could not be parsed as YAML; skipped.')
    status = 'skipped'
  }

  if (!draft.name) {
    issues.push('Missing required field: name.')
    if (status === 'valid') {
      status = 'needs-attention'
    }
  }
  if (!draft.description) {
    issues.push('Missing recommended field: description.')
    if (status === 'valid') {
      status = 'needs-attention'
    }
  }
  if (!draft.instructions) {
    issues.push('No instructions / body content found.')
    if (status === 'valid') {
      status = 'needs-attention'
    }
  }
  if (draft.hasBundledScripts) {
    issues.push('Bundles executable scripts — review before trusting (never executed by discovery).')
  }

  const name = draft.name || '(unnamed)'

  return {
    id: agentId(draft.sourceKind, draft.sourcePath, name),
    name,
    description: draft.description,
    instructions: draft.instructions,
    tools: draft.tools,
    model: draft.model,
    sourceKind: draft.sourceKind,
    sourcePath: draft.sourcePath,
    raw: draft.raw,
    status,
    issues,
    hasBundledScripts: draft.hasBundledScripts,
  }
}
