// Canonical tool names and permission shapes shared by toolGating.ts (pure) and the vscode-bound tool
// implementations (fileTools.ts / adoTools.ts / gitTools.ts). Kept free of `vscode` so gating — and the
// backend that seeds the agent catalog with explicit tool lists — can use it without the extension host.

/** The canonical file tool names. toolGating.ts maps an agent's declared tools onto this set. */
export const CANONICAL_FILE_TOOLS = [
  'read_file',
  'list_dir',
  'write_file',
  'replace_in_file',
  'search_text',
] as const
export type FileToolName = (typeof CANONICAL_FILE_TOOLS)[number]

/** File tools that never mutate the workspace — the only ones offered to a planning turn. */
export const READ_ONLY_FILE_TOOLS: ReadonlySet<FileToolName> = new Set<FileToolName>(['read_file', 'list_dir', 'search_text'])

/** Canonical ADO tool names. Split into read (broadly offered) and write (gated). */
export const ADO_READ_TOOLS = ['list_work_items', 'get_work_item'] as const
export const ADO_WRITE_TOOLS = ['update_work_item', 'add_work_item_comment'] as const
export type AdoReadTool = (typeof ADO_READ_TOOLS)[number]
export type AdoWriteTool = (typeof ADO_WRITE_TOOLS)[number]
export type AdoToolName = AdoReadTool | AdoWriteTool

/** Which ADO tools an agent may use, decided by toolGating. */
export interface AdoToolPermission {
  read: boolean
  write: Set<AdoWriteTool>
}

export const GIT_READ_TOOLS = ['git_status'] as const
export const GIT_WRITE_TOOLS = ['git_commit_and_push', 'create_pull_request'] as const
export type GitReadTool = (typeof GIT_READ_TOOLS)[number]
export type GitWriteTool = (typeof GIT_WRITE_TOOLS)[number]
export type GitToolName = GitReadTool | GitWriteTool

/** Which git tools an agent may use, decided by toolGating. Mirrors AdoToolPermission's shape. */
export interface GitToolPermission {
  read: boolean
  write: Set<GitWriteTool>
}
