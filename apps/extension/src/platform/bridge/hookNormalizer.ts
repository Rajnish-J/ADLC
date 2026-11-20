// Harness hook payloads → run activity events. Pure, so it is tested against fixture payloads. Tool inputs are never
// kept raw: only the tool name, a file path, the subagent or skill name, and a short redacted summary.

import { clipSummary, type RunEventType } from '@sdlc/contracts'

export interface NormalizedEvent {
  type: RunEventType
  agentType?: string | null
  agentName?: string | null
  skill?: string | null
  tool?: string | null
  path?: string | null
  summary?: string | null
  data?: Record<string, unknown>
  /** The harness's own session id, to correlate later hooks with the run. */
  sessionId?: string
}

type Json = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

/** Secrets that must never leave the machine in a summary (tokens, keys, passwords in commands). */
const SECRET = /(\b(?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\b\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"']+|\b(?:ghp|gho|github_pat|sk|xox[bpa])[-_][A-Za-z0-9_-]{10,}/gi

export function redact(text: string): string {
  return text.replace(SECRET, (_m, prefix: string | undefined) => `${prefix ?? ''}[redacted]`)
}

/** Paths the user excluded from sharing (diffExclude) are dropped from activity too. */
export type PathFilter = (path: string) => boolean

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'edit_file', 'create_file', 'write_file', 'replace_string_in_file', 'apply_patch'])

function pathOf(input: Json): string | undefined {
  return str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? str(input.notebook_path) ?? str(input.target_file)
}

function toolSummary(tool: string, input: Json): string | undefined {
  const cmd = str(input.command)
  if (cmd) return clipSummary(redact(cmd).slice(0, 200))
  const pattern = str(input.pattern) ?? str(input.query)
  if (pattern) return clipSummary(`${tool} “${redact(pattern).slice(0, 120)}”`)
  const desc = str(input.description)
  return desc ? clipSummary(redact(desc)) : undefined
}

/**
 * A path as the run's page shows it: relative to the workspace (`root`), with forward slashes. Harnesses report
 * absolute paths (Claude Code's `file_path`); a path outside the workspace stays absolute.
 */
export function relativePath(path: string, root: string | undefined): string {
  const trim = (s: string) => s.replace(/\\/g, '/').replace(/[/]+$/, '')
  const p = trim(path)
  if (!root) return p
  const r = trim(root)
  const windows = /^[a-z]:[/]/i.test(r)
  const inside = windows ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`) : p.startsWith(`${r}/`)
  return inside ? p.slice(r.length + 1) : p
}

/** True for a path `relativePath` left absolute: outside the workspace (never sent — it names local folders). */
const isAbsolutePath = (p: string): boolean => p.startsWith('/') || /^[a-z]:[/]/i.test(p)

/** The workspace-relative path of a file a tool touched, or undefined when it is outside the workspace. */
function workspacePath(raw: string | undefined, root: string | undefined): string | undefined {
  if (!raw) return undefined
  const p = relativePath(raw, root)
  return isAbsolutePath(p) ? undefined : p
}

/** Claude Code hooks (PreToolUse, PostToolUse, SubagentStop, Stop, UserPromptSubmit, …). */
export function normalizeClaudeCode(payload: unknown, allowPath: PathFilter = () => true, root?: string): NormalizedEvent[] {
  const p = obj(payload)
  const workspace = root ?? str(p.cwd)
  const event = str(p.hook_event_name) ?? ''
  const sessionId = str(p.session_id)
  const tool = str(p.tool_name)
  const input = obj(p.tool_input)
  const base = { sessionId }

  switch (event) {
    case 'UserPromptSubmit':
      return [{ ...base, type: 'turn.stopped', summary: 'Prompt submitted', data: { phase: 'prompt' } }]
    case 'Stop':
      return [{ ...base, type: 'turn.stopped', summary: 'The harness finished its turn' }]
    case 'SubagentStop':
      return [{ ...base, type: 'agent.stopped', agentType: str(p.agent_type) ?? str(p.subagent_type) ?? null, summary: 'Subagent finished' }]
    case 'SubagentStart':
      return [{ ...base, type: 'agent.started', agentType: str(p.agent_type) ?? str(p.subagent_type) ?? null }]
    case 'PreToolUse': {
      if (!tool) return []
      if (tool === 'Task' || tool === 'Agent') {
        const agent = str(input.subagent_type) ?? str(input.agent_type)
        return [{ ...base, type: 'agent.started', agentType: agent ?? null, agentName: agent ?? null, tool, summary: str(input.description) ? clipSummary(redact(str(input.description)!)) : null }]
      }
      if (tool === 'Skill') {
        const skill = str(input.skill) ?? str(input.name) ?? str(input.command)
        return [{ ...base, type: 'skill.used', skill: skill ?? null, tool, data: { evidence: 'observed' } }]
      }
      return []
    }
    case 'PostToolUse': {
      if (!tool || tool.startsWith('mcp__sdlc__')) return []
      const raw = pathOf(input)
      const path = workspacePath(raw, workspace)
      const shownPath = path && allowPath(path) ? path : null
      const failed = obj(p.tool_response).is_error === true || obj(p.tool_response).success === false
      const out: NormalizedEvent[] = [
        { ...base, type: failed ? 'tool.failed' : 'tool.called', tool, path: shownPath, summary: shownPath ? null : (toolSummary(tool, input) ?? null) },
      ]
      if (shownPath && FILE_TOOLS.has(tool) && !failed) out.push({ ...base, type: 'file.changed', tool, path: shownPath })
      // A skill read from the user's own skills folder (outside the workspace) still counts; only its slug is kept.
      if (raw && /\/skills\/[^/]+\/SKILL\.md$/i.test(raw.replace(/\\/g, '/'))) {
        const slug = raw.replace(/\\/g, '/').split('/').slice(-2)[0].replace(/^sdlc-/, '')
        out.push({ ...base, type: 'skill.used', skill: slug, tool, data: { evidence: 'observed' } })
      }
      return out
    }
    default:
      return []
  }
}

/** Copilot and other harnesses whose hook payloads use camelCase (best effort; unknown shapes yield nothing). */
export function normalizeGeneric(payload: unknown, allowPath: PathFilter = () => true, root?: string): NormalizedEvent[] {
  const p = obj(payload)
  const event = str(p.hookEventName) ?? str(p.event) ?? str(p.hook_event_name) ?? ''
  if (/claude|PreToolUse|PostToolUse|SubagentStop/.test(event) && p.hook_event_name) return normalizeClaudeCode(payload, allowPath, root)
  const tool = str(p.toolName) ?? str(p.tool_name) ?? str(p.tool)
  const input = obj(p.toolInput ?? p.tool_input ?? p.input)
  const sessionId = str(p.sessionId) ?? str(p.session_id)
  if (/post.?tool/i.test(event) && tool) {
    const path = workspacePath(pathOf(input), root ?? str(p.cwd))
    const shownPath = path && allowPath(path) ? path : null
    const out: NormalizedEvent[] = [{ sessionId, type: 'tool.called', tool, path: shownPath, summary: shownPath ? null : (toolSummary(tool, input) ?? null) }]
    if (shownPath && FILE_TOOLS.has(tool)) out.push({ sessionId, type: 'file.changed', tool, path: shownPath })
    return out
  }
  if (/stop|end/i.test(event)) return [{ sessionId, type: 'turn.stopped', summary: 'The harness finished its turn' }]
  return []
}

export function normalizeHook(engine: string, payload: unknown, allowPath?: PathFilter, root?: string): NormalizedEvent[] {
  return engine === 'claude-code' ? normalizeClaudeCode(payload, allowPath, root) : normalizeGeneric(payload, allowPath, root)
}
