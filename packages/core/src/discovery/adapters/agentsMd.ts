// Adapter: AGENTS.md (vendor-neutral, widely adopted)
//
// Usually a plain markdown file with no frontmatter — guidance for agents working
// in the repo. May optionally carry a YAML block. The H1 (or the file's folder)
// gives the name; the body is the instructions.

import { normalizeTools } from '../agentModel'
import { asString, splitFrontmatter } from '../frontmatter'
import { buildAgent } from '../validator'
import type { DiscoveryAdapter } from './types'

function firstHeading(body: string): string {
  const m = /^#\s+(.+)$/m.exec(body)
  return m ? m[1].trim() : ''
}

export const agentsMdAdapter: DiscoveryAdapter = {
  kind: 'agents-md',
  globs: ['**/AGENTS.md'],

  parse(relPath, content) {
    const { meta, body, malformed } = splitFrontmatter(content)
    const dir = relPath.split('/').slice(-2, -1)[0]
    const name =
      asString(meta.name) ||
      firstHeading(body) ||
      (dir && dir !== '.' ? `${dir} agents` : 'AGENTS')
    return [
      buildAgent({
        sourceKind: 'agents-md',
        sourcePath: relPath,
        raw: content,
        name,
        description: asString(meta.description),
        instructions: body,
        tools: normalizeTools(meta.tools),
        model: asString(meta.model) || undefined,
        malformed,
      }),
    ]
  },
}
