// Adapter: .github/copilot-instructions.md
//
// A single repo-wide instruction file for GitHub Copilot. No agent identity of its
// own — we model it as one "Copilot" instruction agent whose body is the guidance.

import { asString, splitFrontmatter } from '../frontmatter'
import { buildAgent } from '../validator'
import type { DiscoveryAdapter } from './types'

export const copilotAdapter: DiscoveryAdapter = {
  kind: 'copilot-instructions',
  globs: ['.github/copilot-instructions.md'],

  parse(relPath, content) {
    const { meta, body, malformed } = splitFrontmatter(content)
    return [
      buildAgent({
        sourceKind: 'copilot-instructions',
        sourcePath: relPath,
        raw: content,
        name: asString(meta.name) || 'Copilot instructions',
        description:
          asString(meta.description) || 'Repository-wide GitHub Copilot instructions.',
        instructions: body,
        tools: [],
        malformed,
      }),
    ]
  },
}
