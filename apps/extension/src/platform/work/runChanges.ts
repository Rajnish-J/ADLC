// What an agent run changed, for its page on the platform. When a run starts, this records the commit it starts from
// (and which files were already dirty, so earlier unrelated edits aren't blamed on the run). Before each step is
// completed — and once more when the run ends — it diffs the working tree against that commit and reports the
// run's files, line counts, diff and commits. Comparing each snapshot with the previous one gives the files that
// step changed, whichever harness did the work (Copilot sends no hooks, so this is the only way to know).
//
// With diffs shared it also sends each changed text file's full before/after text, so the platform's Code page can
// show the run's branch (which exists only here — it is never pushed) as a side-by-side diff.
//
// Read-only towards git, and free of `vscode` (the store is a Memento), so it is tested against a real repository.

import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  MAX_PATCH_CHARS,
  MAX_RUN_CONTENT_CHARS,
  MAX_RUN_FILE_CHARS,
  type ChangedFile,
  type ReportRunChangesInput,
  type RunCommit,
  type RunFileContent,
} from '@sdlc/contracts'
import type { PlatformClient } from '../platformClient'
import type { GitCli } from './gitCli'
import { diffAgainst, fingerprintFiles, type DiffOptions } from './gitDiff'
import { LOG_FORMAT, clip, parseLog, safePatch } from './gitParse'

const BASES_KEY = 'sdlcGovernance.platform.runBases'
const MAX_REMEMBERED_RUNS = 50
const MAX_INITIAL_FILES = 500
const MAX_COMMITS = 100
const NUL = String.fromCharCode(0)

/** Where VS Code keeps the start of each run across restarts (the workspace's Memento). */
export interface RunChangeStore {
  get<T>(key: string, fallback: T): T
  update(key: string, value: unknown): Thenable<void> | Promise<void>
}

export interface RunRepo {
  git: GitCli
  /** The repository's root folder. */
  root: string
  /** The branch checked out now (null when detached). */
  branch: () => string | null
}

interface RunStart {
  /** The commit the run started from (null: the repository had no commits). */
  sha: string | null
  at: number
  /** Fingerprints of files that were already changed when the run started. */
  initial: Record<string, string>
  /** Fingerprints at the end of the last completed step, so a reloaded window attributes only new edits to the next. */
  last?: Record<string, string>
}

export interface RunChangeTrackerDeps {
  client: () => Pick<PlatformClient, 'reportRunChanges'> | undefined
  store: RunChangeStore
  settings: () => DiffOptions
  log: (message: string) => void
  /** The workspace's repository, for a run whose start is remembered but that this window has not begun (a reload). */
  resolveRepo?: () => Promise<RunRepo | undefined>
}

export interface RunSnapshot {
  report: ReportRunChangesInput
  /** Files that changed since the previous snapshot (the step's files). */
  stepFiles: string[]
}

export class RunChangeTracker {
  private readonly repos = new Map<string, RunRepo>()
  /** Fingerprints at the end of the last completed step: the baseline the next step's files are measured against. */
  private readonly previous = new Map<string, Map<string, string>>()
  /**
   * The latest snapshot of a step being completed. It becomes the baseline only once another step (or the run's end)
   * reports, so a completion that fails and is retried gets the same files again instead of none.
   */
  private readonly pending = new Map<string, { stepId: string; prints: Map<string, string> }>()
  private readonly queue = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: RunChangeTrackerDeps) {}

  private starts(): Record<string, RunStart> {
    return this.deps.store.get<Record<string, RunStart>>(BASES_KEY, {})
  }

  /** The repository root a run is tracked in: hook and watcher paths are made relative to it, like the diff's. */
  rootOf(runId: string): string | undefined {
    return this.repos.get(runId)?.root
  }

  /** The commit a run started from, if it was recorded. */
  baseOf(runId: string): string | null | undefined {
    return this.starts()[runId]?.sha
  }

  /**
   * Record where the run starts (once — a resumed run keeps its original start). Call after its branch is checked
   * out and before any harness works on it.
   */
  async begin(runId: string, repo: RunRepo): Promise<string | null> {
    this.repos.set(runId, repo)
    const all = this.starts()
    const known = all[runId]
    if (known) {
      if (!this.previous.has(runId)) this.previous.set(runId, new Map(Object.entries(known.last ?? known.initial)))
      return known.sha
    }
    const sha = (await repo.git.tryRun(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() || null
    const dirty = sha ? await diffAgainst(repo.git, repo.root, sha, { ...this.deps.settings(), shareDiffs: false }) : { files: [] as ChangedFile[] }
    const initial = Object.fromEntries((await fingerprintFiles(repo.git, dirty.files.slice(0, MAX_INITIAL_FILES))).entries())
    const next: Record<string, RunStart> = { ...all, [runId]: { sha, at: Date.now(), initial } }
    const keep = Object.entries(next)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_REMEMBERED_RUNS)
    await this.deps.store.update(BASES_KEY, Object.fromEntries(keep))
    this.previous.set(runId, new Map(Object.entries(initial)))
    return sha
  }

  /**
   * Diff the run against its start: the report to send, and the files changed since the last completed step. With a
   * `stepId` the snapshot is that step's (kept pending until a different step reports); without one it is final.
   */
  async snapshot(runId: string, stepId?: string): Promise<RunSnapshot | undefined> {
    const repo = this.repos.get(runId)
    const start = this.starts()[runId]
    if (!repo || !start) return undefined
    const settings = this.deps.settings()
    const diff = await diffAgainst(repo.git, repo.root, start.sha, settings)
    const prints = await fingerprintFiles(repo.git, diff.files)
    // A file that was already dirty when the run started, and that the run never touched, isn't the run's.
    const files = diff.files.filter((f) => start.initial[f.path] === undefined || start.initial[f.path] !== prints.get(f.path))
    const ours = new Set(files.map((f) => f.path))

    // A different step reporting means the pending one was completed: its snapshot is the new baseline.
    const waiting = this.pending.get(runId)
    if (waiting && waiting.stepId !== stepId) await this.settle(runId, start, waiting.prints)
    const before = this.previous.get(runId) ?? new Map(Object.entries(start.last ?? start.initial))
    const stepFiles = files.filter((f) => before.get(f.path) !== prints.get(f.path)).map((f) => f.path)
    // Files the previous snapshot had that are gone now were reverted in this step.
    for (const p of before.keys()) if (!prints.has(p) && start.initial[p] === undefined) stepFiles.push(p)
    const now = new Map(files.map((f) => [f.path, prints.get(f.path) ?? '']))
    if (stepId) this.pending.set(runId, { stepId, prints: now })
    else await this.settle(runId, start, now)

    const safe = settings.shareDiffs && diff.patch ? safePatch(diff.patch, (p) => settings.exclude(p) || !ours.has(p), MAX_PATCH_CHARS) : { patch: null, truncated: false }
    const head = (await repo.git.tryRun(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() || null
    const branch = repo.branch()
    return {
      report: {
        branch: branch ? clip(branch, 250) : null,
        baseSha: start.sha,
        headSha: head,
        files: files.slice(0, 2000),
        patch: safe.patch,
        patchTruncated: safe.truncated || diff.incomplete,
        commits: start.sha && head && head !== start.sha ? await this.commits(repo.git, start.sha) : [],
        ...(settings.shareDiffs ? { contents: await fileContents(repo, start.sha, files.slice(0, 2000), settings.exclude) } : {}),
      },
      stepFiles: [...new Set(stepFiles)].slice(0, 500),
    }
  }

  /** Make `prints` the baseline for the next step, here and in the workspace state (it outlives a reload). */
  private async settle(runId: string, start: RunStart, prints: Map<string, string>): Promise<void> {
    this.pending.delete(runId)
    this.previous.set(runId, prints)
    const all = this.starts()
    if (!all[runId]) return
    const last = Object.fromEntries([...prints.entries()].slice(0, MAX_INITIAL_FILES))
    await this.deps.store.update(BASES_KEY, { ...all, [runId]: { ...start, ...all[runId], last } })
  }

  private async commits(git: GitCli, base: string): Promise<RunCommit[]> {
    const log = parseLog((await git.tryRun(['log', `--format=${LOG_FORMAT}`, '-n', String(MAX_COMMITS), `${base}..HEAD`])) ?? '')
    const counts = new Map<string, number>()
    const names = (await git.tryRun(['log', '--format=%x1e%H', '--name-only', '-n', String(MAX_COMMITS), `${base}..HEAD`])) ?? ''
    for (const rec of names.split('\x1e').filter(Boolean)) {
      const [sha, ...paths] = rec.split('\n').map((l) => l.trim())
      if (sha) counts.set(sha, paths.filter(Boolean).length)
    }
    return log.map((e) => ({ sha: e.sha, message: clip(e.message, 2_000), committedAt: e.committedAt || null, files: counts.get(e.sha) ?? 0 }))
  }

  /**
   * Snapshot the run and report it to the platform. Returns the step's files, or undefined when nothing could be
   * worked out — reporting never fails the step that asked for it. Snapshots of one run never overlap.
   */
  report(projectKey: string, runId: string, stepId?: string): Promise<string[] | undefined> {
    const prior = this.queue.get(runId) ?? Promise.resolve()
    const next = prior
      .catch(() => undefined)
      .then(async () => {
        try {
          const snap = await this.snapshot(runId, stepId)
          if (!snap) return undefined
          const client = this.deps.client()
          if (client) await client.reportRunChanges(projectKey, runId, snap.report)
          return snap.stepFiles
        } catch (err) {
          this.deps.log(`Could not report what run ${runId} changed: ${err instanceof Error ? err.message : String(err)}`)
          return undefined
        }
      })
    this.queue.set(runId, next)
    return next
  }

  /** The run ended: report its final changes, then stop tracking it (its start stays remembered for a while). */
  async end(projectKey: string, runId: string): Promise<void> {
    if (!this.repos.has(runId)) {
      // This window lost the run's in-memory state (a reload) but remembers its start: still send the final report.
      const repo = this.starts()[runId] ? await this.deps.resolveRepo?.().catch(() => undefined) : undefined
      if (!repo) return
      await this.begin(runId, repo)
    }
    await this.report(projectKey, runId)
    this.repos.delete(runId)
    this.previous.delete(runId)
    this.pending.delete(runId)
    this.queue.delete(runId)
  }
}

/**
 * The before (at `base`) and after (working tree) text of each changed file the run may share, within the report's
 * size budget. Binary and excluded files are skipped; a file over the per-file cap, or past the budget, is sent as
 * `truncated` with no text (the patch still shows it).
 */
export async function fileContents(
  repo: Pick<RunRepo, 'git' | 'root'>,
  base: string | null,
  files: ChangedFile[],
  exclude: (path: string) => boolean,
): Promise<RunFileContent[]> {
  const out: RunFileContent[] = []
  let budget = MAX_RUN_CONTENT_CHARS
  for (const f of files) {
    if (f.binary || f.excluded || exclude(f.path)) continue
    const entry: RunFileContent = { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), original: null, modified: null, truncated: false }
    if (budget <= 0) {
      out.push({ ...entry, truncated: true })
      continue
    }
    const created = f.status === 'added' || f.status === 'untracked'
    const original = !created && base ? await repo.git.tryRun(['show', `${base}:${f.oldPath ?? f.path}`]) : undefined
    const modified = f.status === 'deleted' ? undefined : await readFile(join(repo.root, f.path), 'utf8').catch(() => undefined)
    const size = (original?.length ?? 0) + (modified?.length ?? 0)
    const tooBig = (original?.length ?? 0) > MAX_RUN_FILE_CHARS || (modified?.length ?? 0) > MAX_RUN_FILE_CHARS || size > budget
    // NUL bytes mean git's binary heuristic missed it: never send it as text.
    if (tooBig || original?.includes(NUL) || modified?.includes(NUL)) {
      out.push({ ...entry, truncated: true })
      continue
    }
    budget -= size
    out.push({ ...entry, original: original ?? null, modified: modified ?? null })
  }
  return out
}
