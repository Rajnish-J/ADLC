// File-editing tools offered to the language model during an agent dispatch.
//
// These are passed *inline* on each `model.sendRequest` (not registered globally via
// vscode.lm.registerTool), so they are scoped to the @sdlc run that offers them and the agent's
// `tools` allow-list (see toolGating.ts) decides which are exposed. We own the implementations and
// execute the calls ourselves in the dispatcher's agentic loop.
//
// Every tool resolves its `path` argument against the active workspace root and rejects escapes
// (`..`, absolute paths, drive letters). Failures are returned as readable *strings* — never thrown —
// so the model can read the error and recover (e.g. re-read a file before editing).

import * as path from 'path'
import * as vscode from 'vscode'

import { CANONICAL_FILE_TOOLS, type FileToolName } from './toolCatalog'

export { CANONICAL_FILE_TOOLS, type FileToolName } from './toolCatalog'

/** Cap a single file read so a huge file can't blow the model's context window. */
const MAX_READ_BYTES = 200 * 1024
/** Cap search hits returned to the model. */
const DEFAULT_SEARCH_RESULTS = 50

/**
 * Pure path-safety check. Given the workspace root and a (workspace-relative) path argument, return
 * the normalized relative path, or `null` if it escapes the root or is absolute. Kept pure (string
 * in, string out) so the escape logic is unit-testable without `vscode`.
 */
export function safeRelativePath(rootFsPath: string, rel: string): string | null {
  if (!rel || typeof rel !== 'string') return null
  // Reject absolute paths and Windows drive letters outright.
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null
  const target = path.resolve(rootFsPath, rel)
  const relative = path.relative(rootFsPath, target)
  if (relative === '') return '.' // the root itself
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  // Normalize to POSIX separators for consistent Uri joining.
  return relative.split(path.sep).join('/')
}

/** The single active workspace folder, or undefined when none is open. */
function workspaceRoot(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0]
}

/**
 * Resolve a workspace-relative path to a Uri under the active workspace root, applying the
 * path-safety check. Returns the Uri or an error string.
 */
export function resolveInWorkspace(rel: string): { uri: vscode.Uri } | { error: string } {
  const root = workspaceRoot()
  if (!root) return { error: 'No workspace folder is open; file tools are unavailable.' }
  const safe = safeRelativePath(root.uri.fsPath, rel)
  if (safe === null) {
    return { error: `Path "${rel}" is outside the workspace or absolute; only workspace-relative paths are allowed.` }
  }
  return { uri: safe === '.' ? root.uri : vscode.Uri.joinPath(root.uri, safe) }
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

/** JSON-schema tool definitions, keyed by canonical name. */
const TOOL_DEFS: Record<FileToolName, vscode.LanguageModelChatTool> = {
  read_file: {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the workspace. The "path" is workspace-relative (POSIX, e.g. "src/app.ts"). Large files are truncated.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
      required: ['path'],
    },
  },
  list_dir: {
    name: 'list_dir',
    description:
      'List the entries of a workspace directory. "path" is workspace-relative (POSIX); omit or use "." for the workspace root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative directory path. Defaults to root.' } },
    },
  },
  write_file: {
    name: 'write_file',
    description:
      'Create or OVERWRITE a UTF-8 text file with the given content. "path" is workspace-relative (POSIX); parent directories are created as needed. Use replace_in_file for surgical edits to existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  replace_in_file: {
    name: 'replace_in_file',
    description:
      'Replace literal text in an existing file. Fails if "find" is not present (re-read the file and try again). By default replaces the first occurrence; set "all" to true to replace every occurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        find: { type: 'string', description: 'Exact literal text to find.' },
        replace: { type: 'string', description: 'Replacement text.' },
        all: { type: 'boolean', description: 'Replace all occurrences instead of just the first.' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  search_text: {
    name: 'search_text',
    description:
      'Search workspace file contents for a string (or regex). Returns matching "path:line: text" lines. Optionally restrict with a glob.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regex to search for.' },
        glob: { type: 'string', description: 'Optional include glob, e.g. "src/**/*.ts". Defaults to all files.' },
        isRegex: { type: 'boolean', description: 'Treat query as a regular expression.' },
        maxResults: { type: 'number', description: `Max matches to return (default ${DEFAULT_SEARCH_RESULTS}).` },
      },
      required: ['query'],
    },
  },
}

/** Files/dirs never read or scanned. Mirrors the discovery scanner's intent. */
const SEARCH_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.sdlc/**}'

type ToolInput = Record<string, unknown>

/**
 * Build the set of tools to offer the model and an `invoke` that executes a call by name.
 * `allowed` is `'all'` or the explicit set of canonical names the agent is permitted to use.
 * `onWrite`, when supplied, is called with the workspace-relative path of every file actually
 * written by `write_file`/`replace_in_file` — used to scope `git_commit_and_push` (gitTools.ts) to
 * only the files this run touched, never the whole working tree.
 */
export function buildFileTools(
  allowed: Set<string> | 'all',
  onWrite?: (rel: string) => void,
): {
  defs: vscode.LanguageModelChatTool[]
  invoke: (name: string, input: ToolInput, token: vscode.CancellationToken) => Promise<string>
} {
  const names = (allowed === 'all' ? [...CANONICAL_FILE_TOOLS] : CANONICAL_FILE_TOOLS.filter((n) => allowed.has(n)))
  const defs = names.map((n) => TOOL_DEFS[n])

  const invoke = async (name: string, input: ToolInput, _token: vscode.CancellationToken): Promise<string> => {
    if (allowed !== 'all' && !allowed.has(name)) {
      return `Tool "${name}" is not permitted for this agent.`
    }
    try {
      switch (name as FileToolName) {
        case 'read_file':
          return await readFile(String(input.path ?? ''))
        case 'list_dir':
          return await listDir(input.path === undefined ? '.' : String(input.path))
        case 'write_file':
          return await writeFile(String(input.path ?? ''), String(input.content ?? ''), onWrite)
        case 'replace_in_file':
          return await replaceInFile(
            String(input.path ?? ''),
            String(input.find ?? ''),
            String(input.replace ?? ''),
            Boolean(input.all),
            onWrite,
          )
        case 'search_text':
          return await searchText(
            String(input.query ?? ''),
            input.glob === undefined ? undefined : String(input.glob),
            Boolean(input.isRegex),
            typeof input.maxResults === 'number' ? input.maxResults : DEFAULT_SEARCH_RESULTS,
          )
        default:
          return `Unknown tool "${name}".`
      }
    } catch (e) {
      return `Tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  return { defs, invoke }
}

/** Reject writes when the workspace isn't trusted (restricted mode). */
function ensureWritable(): string | undefined {
  if (!vscode.workspace.isTrusted) {
    return 'The workspace is not trusted; file modifications are disabled. Trust the workspace to allow edits.'
  }
  if (!workspaceRoot()) return 'No workspace folder is open; cannot write.'
  return undefined
}

async function readFile(rel: string): Promise<string> {
  const r = resolveInWorkspace(rel)
  if ('error' in r) return r.error
  const bytes = await vscode.workspace.fs.readFile(r.uri)
  if (bytes.byteLength > MAX_READ_BYTES) {
    const text = decoder.decode(bytes.slice(0, MAX_READ_BYTES))
    return `${text}\n\n…[truncated: file is ${bytes.byteLength} bytes, showing first ${MAX_READ_BYTES}]`
  }
  return decoder.decode(bytes)
}

async function listDir(rel: string): Promise<string> {
  const r = resolveInWorkspace(rel)
  if ('error' in r) return r.error
  const entries = await vscode.workspace.fs.readDirectory(r.uri)
  if (entries.length === 0) return '(empty directory)'
  return entries
    .map(([name, kind]) => `${name} [${kind === vscode.FileType.Directory ? 'dir' : 'file'}]`)
    .join('\n')
}

async function writeFile(rel: string, content: string, onWrite?: (rel: string) => void): Promise<string> {
  const blocked = ensureWritable()
  if (blocked) return blocked
  const r = resolveInWorkspace(rel)
  if ('error' in r) return r.error
  const parent = vscode.Uri.joinPath(r.uri, '..')
  await vscode.workspace.fs.createDirectory(parent)
  const bytes = encoder.encode(content)
  await vscode.workspace.fs.writeFile(r.uri, bytes)
  onWrite?.(rel)
  const lines = content.length === 0 ? 0 : content.split('\n').length
  return `Wrote ${bytes.byteLength} bytes (${lines} line(s)) to ${rel}.`
}

async function replaceInFile(
  rel: string,
  find: string,
  replace: string,
  all: boolean,
  onWrite?: (rel: string) => void,
): Promise<string> {
  const blocked = ensureWritable()
  if (blocked) return blocked
  if (!find) return 'The "find" argument is empty; nothing to replace.'
  const r = resolveInWorkspace(rel)
  if ('error' in r) return r.error
  const original = decoder.decode(await vscode.workspace.fs.readFile(r.uri))
  if (!original.includes(find)) {
    return `The text to find was not present in ${rel}. Re-read the file to see its current content, then retry with an exact match.`
  }
  const count = all ? original.split(find).length - 1 : 1
  const updated = all ? original.split(find).join(replace) : original.replace(find, replace)
  await vscode.workspace.fs.writeFile(r.uri, encoder.encode(updated))
  onWrite?.(rel)
  return `Replaced ${count} occurrence(s) in ${rel}.`
}

async function searchText(
  query: string,
  glob: string | undefined,
  isRegex: boolean,
  maxResults: number,
): Promise<string> {
  if (!query) return 'The "query" argument is empty.'
  if (!workspaceRoot()) return 'No workspace folder is open; cannot search.'
  let re: RegExp
  try {
    re = isRegex ? new RegExp(query) : new RegExp(escapeRegExp(query))
  } catch (e) {
    return `Invalid regex: ${e instanceof Error ? e.message : String(e)}`
  }
  const files = await vscode.workspace.findFiles(glob || '**/*', SEARCH_EXCLUDE, 2000)
  const hits: string[] = []
  for (const file of files) {
    if (hits.length >= maxResults) break
    let text: string
    try {
      const bytes = await vscode.workspace.fs.readFile(file)
      if (bytes.byteLength > MAX_READ_BYTES) continue
      text = decoder.decode(bytes)
    } catch {
      continue
    }
    const relPath = vscode.workspace.asRelativePath(file, false)
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      if (re.test(lines[i])) hits.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
    }
  }
  if (hits.length === 0) return `No matches for "${query}".`
  return hits.join('\n')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
