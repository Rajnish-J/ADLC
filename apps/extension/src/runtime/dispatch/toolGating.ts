// Governance gate: maps a discovered agent's declared `tools` onto the canonical file-editing tools
// the LM dispatcher is allowed to offer. Pure (no `vscode`) so it's unit-testable.
//
// Because tools are passed per `model.sendRequest`, an agent that lists only "read" is literally never
// offered write_file — the model cannot edit. That makes this the enforcement point, not just advice.

import {
  ADO_WRITE_TOOLS,
  CANONICAL_FILE_TOOLS,
  GIT_WRITE_TOOLS,
  READ_ONLY_FILE_TOOLS,
  type AdoToolPermission,
  type AdoWriteTool,
  type FileToolName,
  type GitToolPermission,
  type GitWriteTool,
} from './toolCatalog'

const CANONICAL = new Set<string>(CANONICAL_FILE_TOOLS)

/**
 * Common names from various agent conventions (Claude, Copilot, Cursor, etc.) mapped to our canonical
 * tool names. Keys are lower-cased. A declared tool that matches neither an alias nor a canonical name
 * is ignored (it may be a non-file capability we don't model).
 */
const ALIASES: Record<string, FileToolName> = {
  edit: 'replace_in_file',
  str_replace: 'replace_in_file',
  str_replace_editor: 'replace_in_file',
  apply_patch: 'replace_in_file',
  write: 'write_file',
  create: 'write_file',
  create_file: 'write_file',
  read: 'read_file',
  view: 'read_file',
  cat: 'read_file',
  ls: 'list_dir',
  list: 'list_dir',
  glob: 'list_dir',
  grep: 'search_text',
  search: 'search_text',
  find: 'search_text',
}

/**
 * Decide which canonical file tools an agent may use.
 * - Empty/undefined `agentTools` → `'all'` (unspecified means "use the feature", not "deny").
 * - Otherwise → the set of canonical tools its declared tools map to (via canonical names + aliases).
 *   Returns `'all'` only when empty; a non-empty list that matches nothing yields an empty set
 *   (the agent declared tools, none of which are file tools → offer no file tools).
 */
export function mapAgentToolsToFileTools(agentTools: string[] | undefined): Set<FileToolName> | 'all' {
  if (!agentTools || agentTools.length === 0) return 'all'
  const result = new Set<FileToolName>()
  for (const raw of agentTools) {
    const key = String(raw).trim().toLowerCase()
    if (CANONICAL.has(key)) {
      result.add(key as FileToolName)
    } else if (ALIASES[key]) {
      result.add(ALIASES[key])
    }
  }
  return result
}

/**
 * Declared-tool names (any convention) that grant an Azure Boards WRITE capability. Read tools are
 * not gated by declaration — they're offered to every agent when ADO is configured.
 */
const ADO_WRITE_ALIASES: Record<string, AdoWriteTool> = {
  update_work_item: 'update_work_item',
  'update-work-item': 'update_work_item',
  create_work_item: 'update_work_item',
  edit_work_item: 'update_work_item',
  add_work_item_comment: 'add_work_item_comment',
  add_comment: 'add_work_item_comment',
  comment: 'add_work_item_comment',
}

/** Generic board capabilities that, when declared, grant ALL write tools. */
const ADO_WRITE_GROUP = new Set(['work_item', 'work-item', 'azure_devops', 'azure-devops', 'boards', 'ado'])

/**
 * Decide which Azure Boards tools an agent may use.
 * - `read` is always true (reads are offered whenever ADO is configured for the run).
 * - `write` contains a write tool only when the agent's declared tools name it (or a board group).
 *   `allowWrites` is the workspace kill-switch: when false, no write tools are granted regardless of
 *   declaration (honoring "confirm before mutating shared systems").
 */
export function mapAgentToolsToAdoTools(
  agentTools: string[] | undefined,
  allowWrites: boolean,
): AdoToolPermission {
  const write = new Set<AdoWriteTool>()
  if (allowWrites && agentTools) {
    for (const raw of agentTools) {
      const key = String(raw).trim().toLowerCase()
      if (ADO_WRITE_ALIASES[key]) write.add(ADO_WRITE_ALIASES[key])
      else if (ADO_WRITE_GROUP.has(key)) for (const w of ADO_WRITE_TOOLS) write.add(w)
    }
  }
  return { read: true, write }
}

/** Declared-tool names (any convention) that grant a git commit/push or PR-creation capability. */
const GIT_WRITE_ALIASES: Record<string, GitWriteTool> = {
  git_commit_and_push: 'git_commit_and_push',
  git_push: 'git_commit_and_push',
  commit_and_push: 'git_commit_and_push',
  push: 'git_commit_and_push',
  create_pull_request: 'create_pull_request',
  create_pr: 'create_pull_request',
  pull_request: 'create_pull_request',
  pr: 'create_pull_request',
}

/** Generic capabilities that, when declared, grant ALL git write tools. */
const GIT_WRITE_GROUP = new Set(['git', 'source_control', 'scm'])

/**
 * Decide which git/PR tools an agent may use.
 * - `read` (git_status) is always true — offered whenever a git repo is detected for the run.
 * - `write` (git_commit_and_push, create_pull_request) requires BOTH the agent's declared tools to
 *   name one (or a git/source_control/scm group) AND the workspace kill-switch `allowPRs` to be on —
 *   a separate, higher-impact switch from `allowAgentWrites` (board writes), since pushing code and
 *   opening a visible PR is a materially larger blast radius than posting a board comment.
 */
export function mapAgentToolsToGitTools(agentTools: string[] | undefined, allowPRs: boolean): GitToolPermission {
  const write = new Set<GitWriteTool>()
  if (allowPRs && agentTools) {
    for (const raw of agentTools) {
      const key = String(raw).trim().toLowerCase()
      if (GIT_WRITE_ALIASES[key]) write.add(GIT_WRITE_ALIASES[key])
      else if (GIT_WRITE_GROUP.has(key)) for (const w of GIT_WRITE_TOOLS) write.add(w)
    }
  }
  return { read: true, write }
}

/** Every tool permission one dispatch may be offered. */
export interface DispatchToolPermissions {
  file: Set<FileToolName> | 'all'
  ado: AdoToolPermission
  git: GitToolPermission
}

/**
 * Decide the tools for one dispatch, layering two safety rules over the per-agent mapping above:
 * - An agent that could not be RESOLVED (its manifest wasn't found) gets read-only file tools and no write
 *   tools. "No declaration means all tools" applies to an agent whose manifest omits `tools` — never to an
 *   agent we know nothing about.
 * - A PLANNING turn gets read-only tools whatever the agent declares: it may inspect the code to plan, but
 *   writing, committing or touching the board happens only in the execute turn, after a human approves.
 */
export function resolveDispatchTools(args: {
  /** The resolved agent's declared tools, or undefined when it declared none. Ignored when `resolved` is false. */
  agentTools: string[] | undefined
  resolved: boolean
  phase: 'plan' | 'execute'
  /** Workspace kill-switch for Azure Boards writes (sdlcGovernance.azureDevOps.allowAgentWrites). */
  allowAdoWrites: boolean
  /** Workspace kill-switch for commit/push/PR (sdlcGovernance.azureDevOps.allowAgentPRs). */
  allowPRs: boolean
}): DispatchToolPermissions {
  const declared = args.resolved ? args.agentTools : []
  const writable = args.resolved && args.phase === 'execute'

  let file: Set<FileToolName> | 'all' = args.resolved ? mapAgentToolsToFileTools(declared) : new Set(READ_ONLY_FILE_TOOLS)
  if (args.phase === 'plan') {
    const base = file === 'all' ? CANONICAL_FILE_TOOLS : [...file]
    file = new Set(base.filter((t) => READ_ONLY_FILE_TOOLS.has(t)))
  }

  return {
    file,
    ado: mapAgentToolsToAdoTools(declared, writable && args.allowAdoWrites),
    git: mapAgentToolsToGitTools(declared, writable && args.allowPRs),
  }
}
