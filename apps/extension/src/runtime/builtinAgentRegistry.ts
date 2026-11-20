// The built-in agents the default "Story delivery" workflow binds by slug (planner, implementer, tester, reviewer,
// pr-author…). They are the same markdown files the SDLC platform seeds its catalog from (packages/core/agents);
// esbuild copies them into dist/agents so the local default resolves real instructions offline, without the
// platform. A project's own mapping (lookupPlatformAgent) still wins when VS Code is signed in.

import * as fs from 'fs'
import * as path from 'path'
import { parseBuiltinAgentFile, type BuiltinAgentFile } from '@sdlc/core/discovery'
import type { InternalAgent } from '../discovery/agentModel'

const registry = new Map<string, InternalAgent>()
const files = new Map<string, BuiltinAgentFile>()

function toInternalAgent(a: BuiltinAgentFile): InternalAgent {
  return {
    id: a.slug,
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    tools: a.tools,
    // Same convention platform and Foundry agents use: a non-file source (never opened as a workspace file).
    sourceKind: 'agent-yaml',
    sourcePath: a.sourcePath,
    raw: '',
    status: 'valid',
    issues: [],
  }
}

/**
 * Where the agent files are: next to the bundle (dist/extension.js → dist/agents), the extension's dist/agents,
 * else the workspace package (unit tests and dev runs compiled to out/).
 */
function candidateDirs(extensionPath: string | undefined): string[] {
  const dirs: string[] = [path.join(__dirname, 'agents')]
  if (extensionPath) dirs.push(path.join(extensionPath, 'dist', 'agents'))
  try {
    dirs.push(path.join(path.dirname(require.resolve('@sdlc/core/package.json')), 'agents'))
  } catch {
    /* bundled: @sdlc/core is inlined, only dist/agents exists */
  }
  return dirs
}

/**
 * Load the built-in agents once (idempotent). A malformed file is skipped and reported through `log`, so one bad
 * file never hides the others. Returns how many were loaded.
 */
export function loadBuiltinAgents(extensionPath?: string, log?: (msg: string) => void): number {
  if (registry.size > 0) return registry.size
  const dir = candidateDirs(extensionPath).find((d) => fs.existsSync(d))
  if (!dir) {
    log?.('Built-in agents not found (dist/agents is missing) — the default workflow needs the platform to resolve its agents.')
    return 0
  }
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    try {
      const file = parseBuiltinAgentFile(name, fs.readFileSync(path.join(dir, name), 'utf8'))
      files.set(file.slug, file)
      registry.set(file.slug, toInternalAgent(file))
    } catch (err) {
      log?.(`Skipped built-in agent ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return registry.size
}

/** A built-in agent by slug, as the dispatcher's resolver sees it (loads the files on first use). */
export function lookupBuiltinAgent(slug: string): InternalAgent | undefined {
  loadBuiltinAgents()
  return registry.get(slug)
}

/** The parsed file behind a built-in agent (name, description, stage, tools, instructions). */
export function builtinAgentFile(slug: string): BuiltinAgentFile | undefined {
  loadBuiltinAgents()
  return files.get(slug)
}

/** All built-in agents, in file order. */
export function listBuiltinAgents(): BuiltinAgentFile[] {
  loadBuiltinAgents()
  return [...files.values()]
}
