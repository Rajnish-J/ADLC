// The tool registry, and the toolset one assistant gets for one turn: its declared tools, minus what the user's
// role, the tool mode or their own switches rule out. Writes always wait for the user's approval (enforced by
// the AI SDK, not the prompt); in "ask" mode reads do too.

import type { Tool } from 'ai'
import {
  ASK_USER_TOOL,
  HANDOFF_TOOL,
  UPDATE_DRAFT_TOOL,
  permissionsFor,
  type Actor,
  type ChatToolInfo,
  type ChatToolMode,
  type DraftKind,
  type Permission,
  type ProjectRole,
} from '@sdlc/contracts'
import { catalogTools } from './catalog'
import { askUserTool, handoffTool, portfolioTool, updateDraftTool } from './drafts'
import { toAiTool, type ChatToolContext, type ChatToolDef } from './kit'
import { memoryTools } from './memory'
import { projectTools } from './projects'
import { repoTools } from './repos'
import { runTools } from './runs'
import { storyTools } from './stories'
import { workflowTools } from './workflows'

export const PLATFORM_TOOLS: ChatToolDef[] = [
  ...projectTools,
  ...workflowTools,
  ...catalogTools,
  ...storyTools,
  ...memoryTools,
  ...runTools,
  ...repoTools,
  portfolioTool,
]
const PLATFORM_BY_NAME = new Map(PLATFORM_TOOLS.map((t) => [t.name, t]))

/** `@read` in an assistant's tool list = every read-only platform tool. */
export const READ_GROUP = '@read'

export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([...PLATFORM_BY_NAME.keys(), ASK_USER_TOOL, HANDOFF_TOOL, UPDATE_DRAFT_TOOL, READ_GROUP])

const ORG_PERMISSIONS: ReadonlySet<Permission> = new Set(['project.create', 'org.manage'])

/** The tool definitions an assistant declares, in order, de-duplicated. */
export function toolDefsFor(names: readonly string[], draft: DraftKind | null): ChatToolDef[] {
  const out = new Map<string, ChatToolDef>()
  for (const name of names) {
    if (name === READ_GROUP) {
      for (const t of PLATFORM_TOOLS) if (t.access === 'read' && t.kind !== 'draft' && !out.has(t.name)) out.set(t.name, t)
    } else if (name === ASK_USER_TOOL) out.set(name, askUserTool)
    else if (name === HANDOFF_TOOL) out.set(name, handoffTool)
    else if (name === UPDATE_DRAFT_TOOL) {
      if (draft) out.set(name, updateDraftTool(draft))
    } else {
      const def = PLATFORM_BY_NAME.get(name)
      if (def) out.set(name, def)
    }
  }
  return [...out.values()]
}

export interface ToolGate {
  actor: Actor
  /** The user's role in the picked project; undefined when they aren't a member (or no project is picked). */
  projectRole: ProjectRole | undefined
  /** A project is picked in the chat. */
  hasProject: boolean
  toolMode: ChatToolMode
  disabled: readonly string[]
}

/** Whether each tool may be offered this turn, and why not when it can't. */
export function toolAvailability(defs: ChatToolDef[], gate: ToolGate): (ChatToolInfo & { def: ChatToolDef })[] {
  const held = new Set(permissionsFor(gate.actor, gate.projectRole))
  const isAdmin = gate.actor.orgRole === 'org_admin'
  return defs.map((def) => {
    const base = { def, name: def.name, label: def.label, access: def.access }
    const fixed = def.kind === 'draft' || def.kind === 'interaction'
    if (!fixed && def.access === 'write' && gate.toolMode === 'read-only') return { ...base, available: false, reason: 'Read-only mode' }
    if (!fixed && gate.disabled.includes(def.name)) return { ...base, available: false, reason: 'Turned off' }
    if (def.permission) {
      if (ORG_PERMISSIONS.has(def.permission)) {
        if (!isAdmin) return { ...base, available: false, reason: 'Org admins only' }
      } else if (gate.hasProject && !held.has(def.permission)) {
        return { ...base, available: false, reason: `Needs ${def.permission} in this project` }
      }
    }
    return { ...base, available: true, reason: null }
  })
}

export interface Toolset {
  tools: Record<string, Tool>
  /** Per-tool approval for streamText's `toolApproval`. */
  approval: Record<string, 'user-approval' | 'not-applicable'>
}

export function buildToolset(available: ChatToolDef[], ctx: ChatToolContext, toolMode: ChatToolMode): Toolset {
  const tools: Record<string, Tool> = {}
  const approval: Toolset['approval'] = {}
  for (const def of available) {
    tools[def.name] = toAiTool(def, ctx)
    const platform = def.kind === undefined || def.kind === 'platform'
    approval[def.name] = platform && (def.access === 'write' || toolMode === 'ask') ? 'user-approval' : 'not-applicable'
  }
  return { tools, approval }
}
