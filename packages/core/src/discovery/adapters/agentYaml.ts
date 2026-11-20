// Adapter: agent.yaml / agent.yml
//
// A whole-file YAML document describing an agent. Field names vary across tools,
// so we accept the common aliases (instructions / system_prompt / prompt; etc.).

import { normalizeTools } from '../agentModel'
import { asString, parseYamlDocument } from '../frontmatter'
import { buildAgent } from '../validator'
import type { DiscoveryAdapter } from './types'

function pick(meta: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (meta[k] !== undefined && meta[k] !== null) {
      return meta[k]
    }
  }
  return undefined
}

export const agentYamlAdapter: DiscoveryAdapter = {
  kind: 'agent-yaml',
  globs: ['**/agent.yaml', '**/agent.yml'],

  parse(relPath, content) {
    const meta = parseYamlDocument(content)
    if (!meta) {
      return [
        buildAgent({
          sourceKind: 'agent-yaml',
          sourcePath: relPath,
          raw: content,
          name: '',
          description: '',
          instructions: '',
          tools: [],
          malformed: true,
        }),
      ]
    }
    return [
      buildAgent({
        sourceKind: 'agent-yaml',
        sourcePath: relPath,
        raw: content,
        name: asString(pick(meta, ['name', 'id', 'title'])),
        description: asString(pick(meta, ['description', 'summary'])),
        instructions: asString(pick(meta, ['instructions', 'system_prompt', 'systemPrompt', 'prompt'])),
        tools: normalizeTools(pick(meta, ['tools', 'allowed_tools', 'allowedTools'])),
        model: asString(pick(meta, ['model'])) || undefined,
      }),
    ]
  },
}
