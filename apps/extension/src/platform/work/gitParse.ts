// Parsing git's output into the platform's code-activity shapes, and making patches safe to send: files matching
// the exclude patterns (secrets) lose their patch, and patches are capped. Pure — no `vscode`, no child process —
// so every rule here is unit-tested.

import type { ChangedFile, FileChangeStatus } from '@sdlc/contracts'

// ─── info/exclude ────────────────────────────────────────────────────────────────────────────────

/** info/exclude lines for folder-relative `paths`, anchored at the repository root (`prefix`: the folder within it). */
export function excludeEntries(paths: string[], prefix = ''): string[] {
  const base = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return [...new Set(paths)].map((p) => `/${base ? `${base}/` : ''}${p.replace(/\\/g, '/').replace(/^\/+/, '')}`)
}

// ─── Exclude patterns ────────────────────────────────────────────────────────────────────────────

/** Default `sdlcGovernance.platform.diffExclude`: never send these files' content, only their names and counts. */
export const DEFAULT_DIFF_EXCLUDE = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.pfx', '**/*.p12', '**/*.keystore', '**/secrets.*', '**/id_rsa*']

/** A small glob → RegExp: `**` (any depth), `*`, `?`, `{a,b}`. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) {
        re += '\\{'
        continue
      }
      re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRe).join('|')})`
      i = end
    } else {
      re += escapeRe(c)
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&')
}

export function makeExcluder(globs: readonly string[]): (path: string) => boolean {
  const res = globs.filter((g) => g.trim()).map((g) => globToRegExp(g.trim()))
  return (path) => {
    const p = path.replace(/\\/g, '/')
    return res.some((r) => r.test(p))
  }
}

// ─── File lists ──────────────────────────────────────────────────────────────────────────────────

const STATUS: Record<string, FileChangeStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type_changed',
  U: 'modified',
}

export interface NameStatus {
  status: FileChangeStatus
  path: string
  oldPath?: string
}

/** `git … --name-status -z`: `M\0path\0`, renames/copies `R100\0old\0new\0`. */
export function parseNameStatusZ(out: string): NameStatus[] {
  const parts = out.split('\0')
  const files: NameStatus[] = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!code) continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i]
      const path = parts[++i]
      if (path) files.push({ status: STATUS[letter], path, oldPath })
    } else {
      const path = parts[++i]
      if (path) files.push({ status: STATUS[letter] ?? 'unknown', path })
    }
  }
  return files
}

export interface NumStat {
  additions: number
  deletions: number
  binary: boolean
}

/** `git … --numstat -z`: `add\tdel\tpath\0`; renames `add\tdel\t\0old\0new\0`; binary files show `-\t-`. */
export function parseNumstatZ(out: string): Map<string, NumStat> {
  const parts = out.split('\0')
  const stats = new Map<string, NumStat>()
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec)
    if (!m) continue
    let path = m[3]
    if (path === '') {
      i++ // old path
      path = parts[++i] ?? ''
    }
    const binary = m[1] === '-' || m[2] === '-'
    stats.set(path, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary })
  }
  return stats
}

/** Join name-status and numstat output into the platform's file list, flagging excluded files. */
export function mergeFileStats(names: NameStatus[], stats: Map<string, NumStat>, isExcluded: (path: string) => boolean): ChangedFile[] {
  return names.map((n) => {
    const s = stats.get(n.path) ?? { additions: 0, deletions: 0, binary: false }
    return {
      path: n.path,
      ...(n.oldPath ? { oldPath: n.oldPath } : {}),
      status: n.status,
      additions: s.additions,
      deletions: s.deletions,
      binary: s.binary,
      excluded: isExcluded(n.path),
    }
  })
}

// ─── Patches ─────────────────────────────────────────────────────────────────────────────────────

export interface PatchSection {
  path: string
  text: string
}

/** Split a unified diff into one section per file (by its `diff --git a/… b/…` header). */
export function splitPatch(patch: string): PatchSection[] {
  const sections: PatchSection[] = []
  const lines = patch.split('\n')
  let current: { path: string; lines: string[] } | undefined
  for (const line of lines) {
    const header = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line)
    if (header) {
      if (current) sections.push({ path: current.path, text: current.lines.join('\n') })
      current = { path: header[2], lines: [line] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.push({ path: current.path, text: current.lines.join('\n').replace(/\n+$/, '') })
  return sections
}

/**
 * Drop excluded files' sections and cap the size. Whole file sections are kept until the cap; a single huge first
 * section is cut. Returns null when nothing is left to send.
 */
export function safePatch(patch: string, isExcluded: (path: string) => boolean, maxChars: number): { patch: string | null; truncated: boolean } {
  const kept = splitPatch(patch).filter((s) => !isExcluded(s.path))
  let out = ''
  let truncated = false
  for (const s of kept) {
    const piece = out ? `\n${s.text}` : s.text
    if (out.length + piece.length > maxChars) {
      truncated = true
      if (!out) out = s.text.slice(0, maxChars)
      break
    }
    out += piece
  }
  return { patch: out ? `${out}\n` : null, truncated }
}

/** A "new file" patch for an untracked file (git diff HEAD doesn't include them). */
export function syntheticAddPatch(path: string, content: string): { patch: string; additions: number } {
  const body = content.replace(/\r\n/g, '\n').replace(/\n$/, '')
  const lines = body === '' ? [] : body.split('\n')
  const hunk = lines.length ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)] : []
  return {
    patch: [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, ...hunk].join('\n'),
    additions: lines.length,
  }
}

/** Text files only: a NUL byte in the first 8 KB means binary. */
export function looksBinary(content: Uint8Array): boolean {
  const n = Math.min(content.length, 8192)
  for (let i = 0; i < n; i++) if (content[i] === 0) return true
  return false
}

// ─── Commits ─────────────────────────────────────────────────────────────────────────────────────

/** `git log` format the tracker uses: record separator, then fields separated by unit separators. */
export const LOG_FORMAT = '%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%B'

export interface LogEntry {
  sha: string
  authorName: string
  authorEmail: string
  committedAt: string
  message: string
}

export function parseLog(out: string): LogEntry[] {
  return out
    .split('\x1e')
    .map((rec) => rec.replace(/^\n+/, ''))
    .filter(Boolean)
    .flatMap((rec) => {
      const [sha, authorName, authorEmail, committedAt, ...rest] = rec.split('\x1f')
      if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha.trim())) return []
      return [{ sha: sha.trim(), authorName: authorName ?? '', authorEmail: authorEmail ?? '', committedAt: committedAt?.trim() ?? '', message: rest.join('\x1f').trim() }]
    })
}

export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}
