// Adapter: .claude/agents/*.md
//
// Claude sub-agent definitions: YAML frontmatter (name, description, tools, model)
// followed by a markdown body that is the agent's system prompt.

import { normalizeTools } from '../agentModel'
import { asString, splitFrontmatter } from '../frontmatter'
import { buildAgent } from '../validator'
import type { DiscoveryAdapter } from './types'

/**
 * The name to use when the front matter has none: the file name (`.claude/agents/reviewer.md` → "reviewer"), or,
 * for files named AGENT.md, the containing folder (`.claude/agents/ba-agent/brd-generator/AGENT.md` → "brd-generator").
 */
export function fallbackName(relPath: string): string {
  const parts = relPath.split('/')
  const file = parts[parts.length - 1] ?? relPath
  const base = file.replace(/\.md$/i, '')
  if (/^agent$/i.test(base) && parts.length >= 2) return parts[parts.length - 2]
  return base || relPath
}

export const claudeAgentAdapter: DiscoveryAdapter = {
  kind: 'claude-agent',
  globs: ['.claude/agents/*.md', '.claude/agents/**/*.md'],

  parse(relPath, content) {
    const { meta, body, malformed } = splitFrontmatter(content)
    return [
      buildAgent({
        sourceKind: 'claude-agent',
        sourcePath: relPath,
        raw: content,
        name: asString(meta.name) || fallbackName(relPath),
        description: asString(meta.description),
        instructions: body,
        tools: normalizeTools(meta.tools),
        model: asString(meta.model) || undefined,
        malformed,
      }),
    ]
  },
}
