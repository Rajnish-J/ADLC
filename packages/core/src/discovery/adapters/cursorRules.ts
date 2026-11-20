// Adapter: .cursor/rules/*.mdc
//
// Cursor "project rules": an .mdc file with YAML frontmatter (description, globs,
// alwaysApply) and a markdown body of rule text. One agent per rule file.

import { asString, splitFrontmatter } from '../frontmatter'
import { buildAgent } from '../validator'
import type { DiscoveryAdapter } from './types'

export const cursorRulesAdapter: DiscoveryAdapter = {
  kind: 'cursor-rules',
  globs: ['.cursor/rules/*.mdc', '.cursor/rules/**/*.mdc'],

  parse(relPath, content) {
    const { meta, body, malformed } = splitFrontmatter(content)
    const fileName = relPath.split('/').pop()?.replace(/\.mdc$/i, '') ?? relPath
    return [
      buildAgent({
        sourceKind: 'cursor-rules',
        sourcePath: relPath,
        raw: content,
        name: asString(meta.name) || fileName,
        description: asString(meta.description),
        instructions: body,
        tools: [],
        malformed,
      }),
    ]
  },
}
