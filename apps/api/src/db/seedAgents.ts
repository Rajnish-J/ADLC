// The platform's built-in agents: the default set every project can use without any agents in its own codebase.
// Each agent is one markdown file in packages/core/agents — YAML front matter (name, description, tools, stage,
// access rule) and a body that is the agent's instructions. The files are shared with the VS Code extension
// (which bundles them for its local default workflow) and are the single source of truth: the seed upserts them
// by slug (idempotent), and the web app shows the body on the agent's page.
//
// `minProjectRole` is the agent's own access rule: below it, a user still SEES the agent but cannot enable, map
// or run it. Org admins can always use every agent.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { EXECUTION_TARGETS, PROJECT_ROLES } from '@sdlc/contracts'
import { parseBuiltinAgentFile } from '@sdlc/core/discovery'
import type { Db } from './client'
import { agents, projectAgents, projects } from './schema'

/** packages/core/agents, resolved through the package so it works from source and from a build. */
const AGENTS_DIR = path.join(path.dirname(require.resolve('@sdlc/core/package.json')), 'agents')

const MetaSchema = z.object({
  executionTarget: z.enum(EXECUTION_TARGETS),
  minProjectRole: z.enum(PROJECT_ROLES).nullable(),
})

export type BuiltinAgent = {
  name: string
  slug: string
  description: string
  category: string
  sdlcStage: string
  executionTarget: (typeof EXECUTION_TARGETS)[number]
  minProjectRole: (typeof PROJECT_ROLES)[number] | null
  tools: string[]
  instructions: string
  sourcePath: string
  contentHash: string
}

/** Parse one agent file (shared parser), then check the platform-only enums. */
export function parseAgentFile(fileName: string, text: string): BuiltinAgent {
  const file = parseBuiltinAgentFile(fileName, text)
  const meta = MetaSchema.safeParse(file)
  if (!meta.success) throw new Error(`${fileName}: invalid front matter — ${meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return { ...file, ...meta.data, contentHash: createHash('sha256').update(text).digest('hex') }
}

export function loadBuiltinAgents(dir: string = AGENTS_DIR): BuiltinAgent[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseAgentFile(f, readFileSync(path.join(dir, f), 'utf8')))
}

/** Upsert the built-in catalog from ./agents and enable every built-in in every project. Returns the count. */
export async function seedBuiltinAgents(db: Db): Promise<number> {
  const builtins = loadBuiltinAgents()
  for (const a of builtins) {
    const values = { ...a, source: 'builtin' as const, kind: 'agent' as const, projectId: null, branch: null }
    const [existing] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.slug, a.slug), isNull(agents.projectId)))
      .limit(1)
    if (existing) await db.update(agents).set(values).where(eq(agents.id, existing.id))
    else await db.insert(agents).values(values)
  }
  // Enable built-ins for every project (keeps any explicit on/off a project already chose).
  await db.execute(sql`
    insert into ${projectAgents} (project_id, agent_id, enabled)
    select p.id, a.id, true from ${projects} p cross join ${agents} a
    where a.source = 'builtin'
    on conflict do nothing`)
  return builtins.length
}
