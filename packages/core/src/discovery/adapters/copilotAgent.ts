// Adapter: .github/agents/*.agent.md
//
// GitHub Copilot custom agents: optional YAML frontmatter (name, description, tools, model) followed by the
// agent's instructions. Without a `name`, Copilot uses the file name (`reviewer.agent.md` → "reviewer").

import { normalizeTools } from '../agentModel'
import { asString, splitFrontmatter } from '../frontmatter'
import { buildAgent } from '../validator'
import type { DiscoveryAdapter } from './types'

export const copilotAgentAdapter: DiscoveryAdapter = {
  kind: 'copilot-agent',
  globs: ['.github/agents/*.agent.md', '.github/agents/**/*.agent.md'],

  parse(relPath, content) {
    const { meta, body, malformed } = splitFrontmatter(content)
    const file = relPath.split('/').pop() ?? relPath
    return [
      buildAgent({
        sourceKind: 'copilot-agent',
        sourcePath: relPath,
        raw: content,
        name: asString(meta.name) || file.replace(/\.agent\.md$/i, ''),
        description: asString(meta.description),
        instructions: body,
        tools: normalizeTools(meta.tools),
        model: asString(meta.model) || undefined,
        malformed,
      }),
    ]
  },
}
