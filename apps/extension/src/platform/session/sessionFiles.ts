// Files a harness session writes into the workspace: the session folder (.sdlc/sessions/<KEY>/ — story, memory,
// ORCHESTRATOR.md, agents, skills, next.md) and the harness's own config that connects it to the SDLC tools. Every
// path is added to .git/info/exclude so nothing is ever committed, and files the repository already tracks are
// never touched (the harness then falls back to file checkpoints).

import * as path from 'path'
import * as vscode from 'vscode'
import { GitCli } from '../work/gitCli'
import { excludeEntries } from '../work/gitParse'
import type { WiringFile } from '../engines/registry'

const EXCLUDE_MARK = '# sdlc-governance (generated, never commit)'
/** Folders of a session that are not a step's checkpoints. */
const KEEP_DIRS = new Set(['agents', 'skills', 'memory-out'])
const enc = new TextEncoder()
const dec = new TextDecoder()

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** Our own hook entries point at the local bridge; older ones (previous runs) are replaced, the user's are kept. */
const isBridgeHook = (entry: unknown): boolean => JSON.stringify(entry).includes('127.0.0.1') && JSON.stringify(entry).includes('/hooks/')

/** Deep-merges `add` into `base`: objects merge, arrays of strings union, hook arrays replace our old entries. */
export function mergeJson(base: unknown, add: unknown, key = ''): unknown {
  if (isObj(base) && isObj(add)) {
    const out: Json = { ...base }
    for (const [k, v] of Object.entries(add)) out[k] = k in base ? mergeJson(base[k], v, k) : v
    return out
  }
  if (Array.isArray(base) && Array.isArray(add)) {
    if (add.every((x) => typeof x === 'string')) return [...new Set([...base, ...add])]
    if (key !== '' && add.some(isBridgeHook)) return [...base.filter((x) => !isBridgeHook(x)), ...add]
    return add
  }
  return add
}

const isEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0)

/**
 * Undoes mergeJson for a run that ended: removes the `sdlc` server entries, our bridge hooks and the strings we
 * added, and any object or array left empty by that — everything the user wrote stays.
 */
export function unmergeJson(base: unknown, add: unknown, key = ''): unknown {
  if (isObj(base) && isObj(add)) {
    const out: Json = { ...base }
    for (const [k, v] of Object.entries(add)) {
      if (!(k in out)) continue
      if (k === 'sdlc') {
        delete out[k]
        continue
      }
      const next = unmergeJson(out[k], v, k)
      if (isEmpty(next) && !isEmpty(out[k])) delete out[k]
      else out[k] = next
    }
    return out
  }
  if (Array.isArray(base) && Array.isArray(add)) {
    if (add.every((x) => typeof x === 'string')) return base.filter((x) => !add.includes(x))
    if (key !== '' && add.some(isBridgeHook)) return base.filter((x) => !isBridgeHook(x))
    return base
  }
  return base
}

/** Removes one `[section]` of a TOML file (up to the next section), leaving the rest untouched. */
export function removeTomlSection(text: string, header: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === header)
  if (start < 0) return text
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l))
  if (end < 0) end = lines.length
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
}

/** Replaces (or appends) one `[section]` of a TOML file, leaving the rest untouched. */
export function upsertTomlSection(text: string, header: string, section: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === header)
  if (start < 0) return `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${section.trimEnd()}\n`
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l))
  if (end < 0) end = lines.length
  return [...lines.slice(0, start), ...section.trimEnd().split('\n'), ...lines.slice(end)].join('\n')
}

export class SessionFiles {
  private readonly git: GitCli | undefined
  private readonly written = new Set<string>()

  constructor(
    private readonly root: vscode.Uri,
    gitPath: string | undefined,
  ) {
    this.git = gitPath ? new GitCli(gitPath, root.fsPath) : undefined
  }

  private uri(rel: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...rel.split('/'))
  }

  async read(rel: string): Promise<string | undefined> {
    try {
      return dec.decode(await vscode.workspace.fs.readFile(this.uri(rel)))
    } catch {
      return undefined
    }
  }

  /** The files (not folders) directly inside a folder; empty when it does not exist. */
  async list(relDir: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.uri(relDir))
      return entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name)
    } catch {
      return []
    }
  }

  /**
   * A story's session folder is reused by every run on it: remove the previous runs' checkpoints — each step's
   * folder holding plan.md / done.md, and the next*.md files — so a files-tier harness never acts on an old plan.
   * Only what was written before `before` (the run's start) goes: a run picked up again after a reload keeps its own.
   */
  async clearCheckpoints(sessionDir: string, before: number): Promise<void> {
    let entries: [string, vscode.FileType][]
    try {
      entries = await vscode.workspace.fs.readDirectory(this.uri(sessionDir))
    } catch {
      return // a first run: nothing there yet
    }
    const older = async (rel: string) => {
      try {
        return (await vscode.workspace.fs.stat(this.uri(rel))).mtime < before
      } catch {
        return false
      }
    }
    for (const [name, type] of entries) {
      const rel = `${sessionDir}/${name}`
      if (type === vscode.FileType.File && /^next(-[\w-]+)?\.md$/i.test(name)) {
        if (await older(rel)) await vscode.workspace.fs.delete(this.uri(rel)).then(undefined, () => undefined)
      } else if (type === vscode.FileType.Directory && !KEEP_DIRS.has(name)) {
        const checkpoints = (await this.list(rel)).filter((f) => /^(plan|done)\.md$/i.test(f))
        if (!checkpoints.length) continue
        const stale = await Promise.all(checkpoints.map((f) => older(`${rel}/${f}`)))
        if (stale.every(Boolean)) await vscode.workspace.fs.delete(this.uri(rel), { recursive: true }).then(undefined, () => undefined)
      }
    }
  }

  /** Moves a file (overwriting the target), creating the target's folder. */
  async move(from: string, to: string): Promise<void> {
    const target = this.uri(to)
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'))
    await vscode.workspace.fs.rename(this.uri(from), target, { overwrite: true })
  }

  /** Whether the repository tracks this path (then we never write it). */
  async isTracked(rel: string): Promise<boolean> {
    if (!this.git) return false
    const out = await this.git.tryRun(['ls-files', '--error-unmatch', '--', rel])
    return out !== undefined && out.trim() !== ''
  }

  async writeText(rel: string, content: string): Promise<void> {
    const uri = this.uri(rel)
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'))
    await vscode.workspace.fs.writeFile(uri, enc.encode(content))
    this.written.add(rel)
  }

  /** Writes one harness config file. Returns false when the repository tracks it (left untouched). */
  async applyWiring(f: WiringFile): Promise<boolean> {
    if (await this.isTracked(f.path)) return false
    const current = await this.read(f.path)
    if (f.kind === 'json-merge') {
      let base: unknown = {}
      try {
        base = current ? JSON.parse(current) : {}
      } catch {
        return false // a hand-edited file we cannot parse: leave it alone
      }
      await this.writeText(f.path, `${JSON.stringify(mergeJson(base, f.content), null, 2)}\n`)
    } else if (f.kind === 'toml-section') {
      await this.writeText(f.path, upsertTomlSection(current ?? '', f.section ?? '', String(f.content)))
    } else {
      await this.writeText(f.path, String(f.content))
    }
    return true
  }

  /**
   * After the run: take our entries out of a harness config file again, so later sessions of that harness don't
   * keep calling a bridge that is gone. A file left with nothing in it is deleted. Tracked files are never touched.
   */
  async removeWiring(f: WiringFile): Promise<void> {
    const current = await this.read(f.path)
    if (current === undefined || (await this.isTracked(f.path))) return
    let next: string
    if (f.kind === 'json-merge') {
      let base: unknown
      try {
        base = JSON.parse(current)
      } catch {
        return // hand-edited into something we can't parse: leave it alone
      }
      const out = unmergeJson(base, f.content)
      next = isEmpty(out) ? '' : `${JSON.stringify(out, null, 2)}\n`
    } else if (f.kind === 'toml-section') {
      next = removeTomlSection(current, f.section ?? '')
    } else {
      return
    }
    if (next === current) return
    if (next.trim()) await vscode.workspace.fs.writeFile(this.uri(f.path), enc.encode(next))
    else await vscode.workspace.fs.delete(this.uri(f.path)).then(undefined, () => undefined)
  }

  /**
   * Lists every generated path in the repository's info/exclude (once). `--git-path` finds the file git actually
   * reads — the common git dir's in a linked worktree, not the worktree's own — and `--show-prefix` anchors entries
   * at the repository root when the opened folder is a subfolder of it.
   */
  async excludeFromGit(paths: string[]): Promise<void> {
    const file = (await this.git?.tryRun(['rev-parse', '--git-path', 'info/exclude']))?.trim()
    if (!file) return
    const prefix = (await this.git?.tryRun(['rev-parse', '--show-prefix']))?.trim() ?? ''
    const exclude = path.isAbsolute(file) ? vscode.Uri.file(file) : vscode.Uri.joinPath(this.root, ...file.split(/[\\/]/))
    let text = ''
    try {
      text = dec.decode(await vscode.workspace.fs.readFile(exclude))
    } catch {
      /* no exclude file yet */
    }
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim()))
    const missing = excludeEntries(paths, prefix).filter((p) => !have.has(p))
    if (!missing.length) return
    const block = `${have.has(EXCLUDE_MARK) ? '' : `\n${EXCLUDE_MARK}\n`}${missing.join('\n')}\n`
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(exclude, '..'))
    await vscode.workspace.fs.writeFile(exclude, enc.encode(`${text.replace(/\s*$/, '')}${text ? '\n' : ''}${block}`))
  }

  /** Every path written so far (workspace-relative). */
  paths(): string[] {
    return [...this.written]
  }
}
