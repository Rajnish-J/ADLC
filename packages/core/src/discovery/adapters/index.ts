// Adapter registry + dedupe priority.
//
// Adding a new convention is purely additive: write an adapter and append it here.
// SOURCE_PRIORITY breaks ties when the same agent is declared under multiple
// conventions (lower index = preferred survivor in dedupe).

import type { SourceKind } from '../agentModel'
import type { DiscoveryAdapter } from './types'
import { claudeAgentAdapter } from './claudeAgent'
import { claudeSkillAdapter } from './claudeSkill'
import { agentsMdAdapter } from './agentsMd'
import { agentYamlAdapter } from './agentYaml'
import { copilotAdapter } from './copilot'
import { copilotAgentAdapter } from './copilotAgent'
import { cursorRulesAdapter } from './cursorRules'

export const ADAPTERS: readonly DiscoveryAdapter[] = [
  claudeAgentAdapter,
  claudeSkillAdapter,
  agentsMdAdapter,
  agentYamlAdapter,
  copilotAdapter,
  copilotAgentAdapter,
  cursorRulesAdapter,
]

/** Preferred survivor order for dedupe (earlier wins). */
export const SOURCE_PRIORITY: SourceKind[] = [
  'claude-agent',
  'claude-skill',
  'agents-md',
  'agent-yaml',
  'copilot-agent',
  'cursor-rules',
  'copilot-instructions',
]

export function sourceRank(kind: SourceKind): number {
  const i = SOURCE_PRIORITY.indexOf(kind)
  return i === -1 ? SOURCE_PRIORITY.length : i
}
