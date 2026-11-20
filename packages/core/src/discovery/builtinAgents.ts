// The built-in agents the default workflow binds by slug ("planner", "implementer"…). Each agent is one markdown
// file in packages/core/agents — YAML front matter (name, slug, description, tools, stage, access rule) and a
// body that is the agent's instructions. The API seeds its catalog from these files; the VS Code extension
// bundles them so the local default workflow resolves the same agents offline.
//
// Pure parsing only (no `fs`): each consumer reads the files its own way.

import * as yaml from 'js-yaml'

/** Repo-relative folder the built-in agent files live in (shown as an agent's source path). */
export const BUILTIN_AGENTS_SOURCE_DIR = 'packages/core/agents'

export interface BuiltinAgentFile {
  name: string
  slug: string
  description: string
  category: string
  sdlcStage: string
  executionTarget: string
  minProjectRole: string | null
  tools: string[]
  /** The markdown body: the agent's instructions. */
  instructions: string
  /** `packages/core/agents/<slug>.md`. */
  sourcePath: string
}

const SLUG = /^[a-z0-9-]+$/

function str(meta: Record<string, unknown>, key: string, fileName: string): string {
  const v = meta[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${fileName}: front matter "${key}" must be a non-empty string`)
  return v.trim()
}

/** Parse one agent file: `---\n<yaml>\n---\n<markdown body>`. Throws a clear error on a malformed file. */
export function parseBuiltinAgentFile(fileName: string, text: string): BuiltinAgentFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${fileName}: missing YAML front matter`)
  const loaded = yaml.load(match[1])
  if (!loaded || typeof loaded !== 'object') throw new Error(`${fileName}: front matter is not a YAML mapping`)
  const meta = loaded as Record<string, unknown>
  const slug = str(meta, 'slug', fileName)
  if (!SLUG.test(slug)) throw new Error(`${fileName}: slug "${slug}" must be lowercase letters, digits and dashes`)
  if (`${slug}.md` !== fileName) throw new Error(`${fileName}: slug "${slug}" must match the file name`)
  const tools = meta.tools
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')) throw new Error(`${fileName}: "tools" must be a list of strings`)
  const role = meta.minProjectRole
  if (role !== null && role !== undefined && typeof role !== 'string') throw new Error(`${fileName}: "minProjectRole" must be a role or null`)
  return {
    name: str(meta, 'name', fileName),
    slug,
    description: str(meta, 'description', fileName),
    category: str(meta, 'category', fileName),
    sdlcStage: str(meta, 'sdlcStage', fileName),
    executionTarget: str(meta, 'executionTarget', fileName),
    minProjectRole: role ?? null,
    tools: tools as string[],
    instructions: match[2].trim(),
    sourcePath: `${BUILTIN_AGENTS_SOURCE_DIR}/${fileName}`,
  }
}
