// Reports what a developer is doing on a story branch to the SDLC platform, so leads and teammates see it in the
// web app and in their own VS Code:
//   • live working state — uncommitted files with +/− counts and the diff, a few seconds after edits settle
//   • commits — each commit on the story branch (since it left the main line), with files and diff
// Only on branches linked to a story (story/PAY-2-… or an explicit link), only when the story is the developer's
// (the API's canReportWork), and never the content of files matching sdlcGovernance.platform.diffExclude.
// Read-only towards git: it runs diff/log/show, never anything that changes the repository.

import * as vscode from 'vscode'
import { MAX_PATCH_CHARS, type ReportedCommit, type Story } from '@sdlc/contracts'
import type { API, Repository } from '../../@types/git'
import { getGitApi } from '../../integrations/git/gitRepository'
import { PlatformError, type PlatformClient } from '../platformClient'
import { GitCli } from './gitCli'
import { diffAgainst } from './gitDiff'
import { DEFAULT_DIFF_EXCLUDE, LOG_FORMAT, clip, makeExcluder, mergeFileStats, parseLog, parseNameStatusZ, parseNumstatZ, safePatch } from './gitParse'
import { resolveStory, storyKeyOf, type StoryRef } from './storyRef'

const DEBOUNCE_MS = 5_000
const STORY_CACHE_MS = 60_000
const LINKS_KEY = 'sdlcGovernance.platform.branchLinks'
const REPORTED_KEY = 'sdlcGovernance.platform.reportedCommits'

export type TrackingState =
  | { kind: 'idle' }
  | { kind: 'tracking'; story: StoryRef; title: string; files: number }
  | { kind: 'not-yours'; story: StoryRef; title?: string }
  | { kind: 'unknown-story'; story: StoryRef }
  | { kind: 'off'; story: StoryRef }
  | { kind: 'offline'; story: StoryRef; message: string }

interface RepoState {
  repo: Repository
  git: GitCli
  timer?: ReturnType<typeof setTimeout>
  running?: Promise<void>
  again: boolean
  story?: StoryRef
  reportable: boolean
  lastSnapshot?: string
  lastHead?: string
  state: TrackingState
}

interface Settings {
  track: boolean
  shareDiffs: boolean
  exclude: (path: string) => boolean
  targetBranch: string | undefined
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('sdlcGovernance')
  return {
    track: cfg.get<boolean>('platform.trackCodeActivity', true),
    shareDiffs: cfg.get<boolean>('platform.shareDiffs', true),
    exclude: makeExcluder(cfg.get<string[]>('platform.diffExclude', DEFAULT_DIFF_EXCLUDE)),
    targetBranch: cfg.get<string>('azureDevOps.targetBranch', '')?.trim() || undefined,
  }
}

export interface CodeActivityDeps {
  client: () => PlatformClient | undefined
  workspaceState: vscode.Memento
  log: (message: string) => void
}

export class CodeActivityTracker implements vscode.Disposable {
  private api: API | undefined
  private readonly repos = new Map<string, RepoState>()
  private readonly storyCache = new Map<string, { story: Story | null; at: number }>()
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly _onDidChangeState = new vscode.EventEmitter<TrackingState>()
  /** Fires when the tracked story or its tracking state changes (status bar, story panel). */
  readonly onDidChangeState = this._onDidChangeState.event

  constructor(private readonly deps: CodeActivityDeps) {}

  async start(): Promise<void> {
    this.api = await getGitApi()
    if (!this.api) {
      this.deps.log('Code activity: the built-in Git extension is not available; nothing is tracked.')
      return
    }
    for (const repo of this.api.repositories) this.add(repo)
    this.subscriptions.push(
      this.api.onDidOpenRepository((repo) => this.add(repo)),
      this.api.onDidCloseRepository((repo) => this.remove(repo)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sdlcGovernance.platform') || e.affectsConfiguration('sdlcGovernance.azureDevOps.targetBranch')) this.refresh()
      }),
    )
  }

  /** The story of the repository currently being tracked (the first one on a story branch). */
  activeStory(): StoryRef | undefined {
    for (const r of this.repos.values()) if (r.story) return r.story
    return undefined
  }

  currentState(): TrackingState {
    for (const r of this.repos.values()) if (r.state.kind !== 'idle') return r.state
    return { kind: 'idle' }
  }

  /** The checked-out branch of the first repository (for "Link this branch to a story"). */
  currentBranch(): string | undefined {
    for (const r of this.repos.values()) {
      const name = r.repo.state.HEAD?.name
      if (name) return name
    }
    return undefined
  }

  branchLinks(): Record<string, string> {
    return this.deps.workspaceState.get<Record<string, string>>(LINKS_KEY, {})
  }

  async linkBranch(branch: string, storyKey: string | undefined): Promise<void> {
    const links = { ...this.branchLinks() }
    if (storyKey) links[branch] = storyKey
    else delete links[branch]
    await this.deps.workspaceState.update(LINKS_KEY, links)
    this.refresh()
  }

  /** Re-evaluate every repository now (connection, settings or story assignment changed). */
  refresh(): void {
    this.storyCache.clear()
    for (const r of this.repos.values()) {
      r.lastSnapshot = undefined
      this.schedule(r, 0)
    }
  }

  /** A story changed on the platform (e.g. it was assigned to someone): forget what we knew about it. */
  storyChanged(projectKey: string, number: number): void {
    const key = `${projectKey}-${number}`
    if (!this.storyCache.delete(key)) return
    for (const r of this.repos.values()) if (r.story && storyKeyOf(r.story) === key) this.schedule(r, 0)
  }

  private add(repo: Repository): void {
    const id = repo.rootUri.toString()
    if (this.repos.has(id) || !this.api) return
    const r: RepoState = { repo, git: new GitCli(this.api.git.path, repo.rootUri.fsPath), again: false, reportable: false, state: { kind: 'idle' } }
    this.repos.set(id, r)
    this.subscriptions.push(repo.state.onDidChange(() => this.schedule(r, DEBOUNCE_MS)))
    this.schedule(r, 1_000)
  }

  private remove(repo: Repository): void {
    const id = repo.rootUri.toString()
    const r = this.repos.get(id)
    if (r?.timer) clearTimeout(r.timer)
    this.repos.delete(id)
  }

  private schedule(r: RepoState, delay: number): void {
    if (r.timer) clearTimeout(r.timer)
    r.timer = setTimeout(() => {
      r.timer = undefined
      void this.process(r)
    }, delay)
  }

  private setState(r: RepoState, state: TrackingState): void {
    const before = JSON.stringify(r.state)
    r.state = state
    if (JSON.stringify(state) !== before) this._onDidChangeState.fire(this.currentState())
  }

  private async process(r: RepoState): Promise<void> {
    if (r.running) {
      r.again = true
      return
    }
    r.running = this.processOnce(r)
      .catch((err: unknown) => this.deps.log(`Code activity: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        r.running = undefined
        if (r.again) {
          r.again = false
          this.schedule(r, DEBOUNCE_MS)
        }
      })
    await r.running
  }

  private async processOnce(r: RepoState): Promise<void> {
    const client = this.deps.client()
    const settings = readSettings()
    const head = r.repo.state.HEAD
    const branch = head?.name
    const story = client ? resolveStory(branch, this.branchLinks()) : undefined

    // Left a story branch (or stopped tracking): take our "working now" snapshot off the old story.
    const previous = r.story
    const leaving = previous && r.reportable && (!story || storyKeyOf(previous) !== storyKeyOf(story) || !settings.track)
    if (leaving && client) {
      await client.clearWorkspace(previous.projectKey, previous.number).catch(() => undefined)
      r.lastSnapshot = undefined
    }
    if (!story || !client || !branch) {
      r.story = undefined
      r.reportable = false
      this.setState(r, { kind: 'idle' })
      return
    }
    if (!previous || storyKeyOf(previous) !== storyKeyOf(story)) {
      r.lastSnapshot = undefined
      r.lastHead = undefined
    }
    r.story = story
    if (!settings.track) {
      r.reportable = false
      this.setState(r, { kind: 'off', story })
      return
    }

    let platformStory: Story | null
    try {
      platformStory = await this.lookup(client, story)
    } catch (err) {
      r.reportable = false
      this.setState(r, { kind: 'offline', story, message: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!platformStory) {
      r.reportable = false
      this.setState(r, { kind: 'unknown-story', story })
      return
    }
    if (!platformStory.actions.canReportWork) {
      r.reportable = false
      this.setState(r, { kind: 'not-yours', story, title: platformStory.title })
      return
    }
    r.reportable = true

    const files = await this.reportWorkingState(r, client, story, branch, settings)
    if (head?.commit && head.commit !== r.lastHead) {
      await this.reportNewCommits(r, client, story, branch, settings)
      r.lastHead = head.commit
    }
    this.setState(r, { kind: 'tracking', story, title: platformStory.title, files })
  }

  private async lookup(client: PlatformClient, story: StoryRef): Promise<Story | null> {
    const key = storyKeyOf(story)
    const cached = this.storyCache.get(key)
    if (cached && Date.now() - cached.at < STORY_CACHE_MS) return cached.story
    try {
      const found = await client.story(story.projectKey, story.number)
      this.storyCache.set(key, { story: found, at: Date.now() })
      return found
    } catch (err) {
      if (err instanceof PlatformError && err.status === 404) {
        this.storyCache.set(key, { story: null, at: Date.now() })
        return null
      }
      throw err
    }
  }

  // ─── Working state ─────────────────────────────────────────────────────────────────────────────

  private async reportWorkingState(r: RepoState, client: PlatformClient, story: StoryRef, branch: string, s: Settings): Promise<number> {
    const head = r.repo.state.HEAD
    const { files, patch, incomplete } = await diffAgainst(r.git, r.repo.rootUri.fsPath, head?.commit ? 'HEAD' : null, s)
    const safe = s.shareDiffs && patch ? safePatch(patch, s.exclude, MAX_PATCH_CHARS) : { patch: null, truncated: false }
    const snapshot = {
      branch: clip(branch, 250),
      headSha: head?.commit ?? null,
      ahead: head?.ahead ?? 0,
      behind: head?.behind ?? 0,
      files: files.slice(0, 1000),
      patch: safe.patch,
      patchTruncated: safe.truncated || incomplete,
    }
    const fingerprint = JSON.stringify(snapshot)
    if (fingerprint !== r.lastSnapshot) {
      await client.reportWorkspace(story.projectKey, story.number, snapshot)
      r.lastSnapshot = fingerprint
    }
    return files.length
  }

  // ─── Commits ───────────────────────────────────────────────────────────────────────────────────

  private reportedShas(story: StoryRef): Set<string> {
    const all = this.deps.workspaceState.get<Record<string, string[]>>(REPORTED_KEY, {})
    return new Set(all[storyKeyOf(story)] ?? [])
  }

  private async rememberShas(story: StoryRef, shas: Set<string>): Promise<void> {
    const all = { ...this.deps.workspaceState.get<Record<string, string[]>>(REPORTED_KEY, {}) }
    all[storyKeyOf(story)] = [...shas].slice(-500)
    await this.deps.workspaceState.update(REPORTED_KEY, all)
  }

  private async reportNewCommits(r: RepoState, client: PlatformClient, story: StoryRef, branch: string, s: Settings): Promise<void> {
    const base = await r.git.baseCommit(s.targetBranch)
    const range = base ? [`${base}..HEAD`] : ['-n', '20', 'HEAD']
    const entries = parseLog(await r.git.run(['log', `--format=${LOG_FORMAT}`, '-n', '50', ...range])).reverse()
    const seen = this.reportedShas(story)
    const fresh = entries.filter((e) => !seen.has(e.sha))
    if (fresh.length === 0) return

    for (let i = 0; i < fresh.length; i += 20) {
      const batch: ReportedCommit[] = []
      for (const e of fresh.slice(i, i + 20)) {
        const names = parseNameStatusZ(await r.git.run(['show', '--format=', '--name-status', '-z', '-M', e.sha]))
        const stats = parseNumstatZ(await r.git.run(['show', '--format=', '--numstat', '-z', '-M', e.sha]))
        const raw = s.shareDiffs ? await r.git.run(['show', '--format=', '--no-ext-diff', '-M', e.sha]) : ''
        const safe = raw ? safePatch(raw, s.exclude, MAX_PATCH_CHARS) : { patch: null, truncated: false }
        batch.push({
          sha: e.sha,
          branch: clip(branch, 250),
          message: clip(e.message, 5_000),
          authorName: clip(e.authorName, 200),
          authorEmail: clip(e.authorEmail, 320),
          committedAt: e.committedAt,
          files: mergeFileStats(names, stats, s.exclude).slice(0, 2000),
          patch: safe.patch,
          patchTruncated: safe.truncated,
        })
      }
      await client.reportCommits(story.projectKey, story.number, { commits: batch })
      for (const c of batch) seen.add(c.sha)
      await this.rememberShas(story, seen)
    }
    this.deps.log(`Code activity: reported ${fresh.length} commit${fresh.length === 1 ? '' : 's'} on ${storyKeyOf(story)}.`)
  }

  dispose(): void {
    for (const r of this.repos.values()) if (r.timer) clearTimeout(r.timer)
    for (const s of this.subscriptions) s.dispose()
    this._onDidChangeState.dispose()
  }
}
