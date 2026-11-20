// Adapter: .claude/skills/**/SKILL.md
//
// Claude skills: YAML frontmatter (name, description, optional allowed-tools)
// + a markdown body. Skills may BUNDLE executable files (scripts/) in their
// folder — discovery never runs them; the scanner sets `hasBundledScripts` after
// inspecting sibling files (this pure adapter can't see the folder), and we also
// flag here when frontmatter advertises shell/Bash tools as an early hint.

import { normalizeTools } from '../agentModel'
import { asString, splitFrontmatter } from '../frontmatter'
import { buildAgent } from '../validator'
import type { DiscoveryAdapter } from './types'

export const claudeSkillAdapter: DiscoveryAdapter = {
  kind: 'claude-skill',
  globs: ['.claude/skills/**/SKILL.md'],

  parse(relPath, content) {
    const { meta, body, malformed } = splitFrontmatter(content)
    const tools = normalizeTools(meta.tools ?? meta['allowed-tools'])
    const advertisesShell = tools.some((t) => /^(bash|shell|sh|exec)$/i.test(t))
    // Folder slug as a fallback name (…/skills/<slug>/SKILL.md).
    const folder = relPath.split('/').slice(-2, -1)[0] ?? relPath
    return [
      buildAgent({
        sourceKind: 'claude-skill',
        sourcePath: relPath,
        raw: content,
        name: asString(meta.name) || folder,
        description: asString(meta.description),
        instructions: body,
        tools,
        model: asString(meta.model) || undefined,
        malformed,
        hasBundledScripts: advertisesShell || undefined,
      }),
    ]
  },
}
