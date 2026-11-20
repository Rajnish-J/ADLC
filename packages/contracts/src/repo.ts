// A project's linked git repository (GitHub or Azure Repos), as the platform stores it: the server clones it into
// the database (honouring .gitignore), indexes branches on demand, and lets members browse, edit and commit files.
// Pure helpers here are shared by the API (validation), the web app (live hints) and the extension (remote matching).

import { z } from 'zod'
import { RepoCredentialSchema } from './connections'

// ─── Providers & URLs ────────────────────────────────────────────────────────────────────────────

/**
 * `local` is a `file://` remote — accepted only by an API running in development, for tests.
 * `workspace` has no remote at all: a blank project's files live only in the platform's database until someone
 * publishes it to GitHub. `parseRepoUrl` never returns it.
 */
export const REPO_PROVIDERS = ['github', 'azure-repos', 'local', 'workspace'] as const
export type RepoProvider = (typeof REPO_PROVIDERS)[number]

export const REPO_PROVIDER_LABELS: Record<RepoProvider, string> = {
  github: 'GitHub',
  'azure-repos': 'Azure Repos',
  local: 'Local (dev)',
  workspace: 'Workspace',
}

export interface ParsedRepoUrl {
  provider: RepoProvider
  /** HTTPS clone URL without credentials (or the `file://` URL for `local`). */
  cloneUrl: string
  /** Browser URL of the repository; null for `local`. */
  webUrl: string | null
  /** GitHub owner or Azure DevOps organisation. */
  owner: string
  /** Azure DevOps project; null for GitHub. */
  project: string | null
  repo: string
  /** `owner/repo` (GitHub) or `org/project/repo` (Azure) — for labels. */
  displayName: string
}

export type RepoUrlResult = { ok: true; repo: ParsedRepoUrl } | { ok: false; error: string }

export interface AzureGitRemote {
  org: string
  project: string
  repo: string
}

/**
 * Parse an Azure Repos remote URL into org/project/repo. Handles the HTTPS forms (with or without a leading
 * "org@" userinfo segment, and the legacy *.visualstudio.com host) and the SSH form. Returns undefined for anything
 * else (e.g. a GitHub remote).
 */
export function parseAzureGitRemote(url: string | undefined): AzureGitRemote | undefined {
  if (!url) return undefined
  const trimmed = url.trim()

  const ssh = trimmed.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (ssh) return decodeAzure(ssh)

  const https = trimmed.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/)
  if (https) return decodeAzure(https)

  const legacy = trimmed.match(/^https:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/)
  if (legacy) return decodeAzure(legacy)

  return undefined
}

function decodeAzure(m: RegExpMatchArray): AzureGitRemote {
  return { org: safeDecode(m[1]), project: safeDecode(m[2]), repo: safeDecode(m[3]) }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/

/**
 * Validate and normalise a repository URL. Accepts GitHub (`https://github.com/o/r`, `git@github.com:o/r.git`)
 * and Azure Repos (`https://dev.azure.com/o/p/_git/r`, `https://org@dev.azure.com/…`, `https://o.visualstudio.com/p/_git/r`,
 * `git@ssh.dev.azure.com:v3/o/p/r`). SSH forms are converted to HTTPS (the platform authenticates with a token).
 * URLs carrying credentials are rejected — the token has its own field.
 */
export function parseRepoUrl(raw: string, opts: { allowLocal?: boolean } = {}): RepoUrlResult {
  const url = raw.trim()
  if (!url) return { ok: false, error: 'Enter the repository URL.' }

  if (/^file:\/\//i.test(url)) {
    if (!opts.allowLocal) return { ok: false, error: 'Use a GitHub or Azure Repos URL.' }
    const name = url.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/i, '') || 'repo'
    return { ok: true, repo: { provider: 'local', cloneUrl: url, webUrl: null, owner: 'local', project: null, repo: name, displayName: name } }
  }

  // Credentials embedded in an https URL ("https://user:token@host/…") — never accept them silently.
  const userinfo = url.match(/^https?:\/\/([^@/]+)@/i)
  if (userinfo && userinfo[1].includes(':')) {
    return { ok: false, error: 'Remove the user name and password from the URL.' }
  }

  const azure = parseAzureGitRemote(url)
  if (azure) {
    const base = `https://dev.azure.com/${encodeURIComponent(azure.org)}/${encodeURIComponent(azure.project)}/_git/${encodeURIComponent(azure.repo)}`
    return {
      ok: true,
      repo: {
        provider: 'azure-repos',
        cloneUrl: base,
        webUrl: base,
        owner: azure.org,
        project: azure.project,
        repo: azure.repo,
        displayName: `${azure.org}/${azure.project}/${azure.repo}`,
      },
    }
  }

  const gh =
    url.match(/^https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i) ??
    url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    url.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (gh && GITHUB_NAME.test(gh[1]) && GITHUB_NAME.test(gh[2])) {
    const [owner, repo] = [gh[1], gh[2]]
    return {
      ok: true,
      repo: {
        provider: 'github',
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        webUrl: `https://github.com/${owner}/${repo}`,
        owner,
        project: null,
        repo,
        displayName: `${owner}/${repo}`,
      },
    }
  }

  if (/github\.com/i.test(url)) return { ok: false, error: 'Use the repository URL, e.g. https://github.com/owner/repo.' }
  if (/dev\.azure\.com|visualstudio\.com/i.test(url)) {
    return { ok: false, error: 'Use the repository URL, e.g. https://dev.azure.com/org/project/_git/repo.' }
  }
  return { ok: false, error: 'Only GitHub and Azure Repos URLs are supported.' }
}

/**
 * Do two remote URLs name the same GitHub / Azure Repos repository? HTTPS, SSH and `.git` spellings all compare
 * equal, and credentials a local clone keeps in its remote (`https://user:token@github.com/…`) are ignored. Anything
 * the platform can't parse never matches. Used to find the VS Code window that has a project's repo open.
 */
export function sameRepository(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const pa = parseRepoUrl(withoutCredentials(a))
  const pb = parseRepoUrl(withoutCredentials(b))
  return pa.ok && pb.ok && pa.repo.cloneUrl.toLowerCase() === pb.repo.cloneUrl.toLowerCase()
}

/** `https://user:secret@host/…` → `https://host/…`; a bare user name (`https://org@dev.azure.com/…`) is kept. */
function withoutCredentials(url: string): string {
  return url.trim().replace(/^(https?:\/\/)[^@/]+:[^@/]*@/i, '$1')
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/** `a=1&b=2`, encoded (contracts target plain ES2020 — no URLSearchParams). */
function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

/** Browser link to one file on a branch (and optionally a line). Null when the provider has no web UI. */
export function fileWebUrl(repo: { provider: RepoProvider; webUrl: string | null }, branch: string, path: string, line?: number): string | null {
  if (!repo.webUrl) return null
  if (repo.provider === 'github') {
    return `${repo.webUrl}/blob/${encodePath(branch)}/${encodePath(path)}${line ? `#L${line}` : ''}`
  }
  if (repo.provider === 'azure-repos') {
    const params: Record<string, string> = { path: `/${path}`, version: `GB${branch}` }
    if (line) params.line = String(line)
    return `${repo.webUrl}?${query(params)}`
  }
  return null
}

/** Browser link to a branch. */
export function branchWebUrl(repo: { provider: RepoProvider; webUrl: string | null }, branch: string): string | null {
  if (!repo.webUrl) return null
  if (repo.provider === 'github') return `${repo.webUrl}/tree/${encodePath(branch)}`
  if (repo.provider === 'azure-repos') return `${repo.webUrl}?${query({ version: `GB${branch}` })}`
  return null
}

/** Browser link to a commit. */
export function commitWebUrl(repo: { provider: RepoProvider; webUrl: string | null }, sha: string): string | null {
  if (!repo.webUrl) return null
  if (repo.provider === 'github') return `${repo.webUrl}/commit/${sha}`
  if (repo.provider === 'azure-repos') return `${repo.webUrl}/commit/${sha}`
  return null
}

// ─── Names & paths ───────────────────────────────────────────────────────────────────────────────

/** A branch name git accepts (`git check-ref-format --branch`), minus the rarely used edge cases. */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 250) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  if (name === '@' || name.includes('..') || name.includes('//') || name.includes('@{')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** A repo-relative file path: forward slashes, no `..`, no leading slash, no NUL. Empty string = the root. */
export function isValidRepoPath(path: string, opts: { allowRoot?: boolean } = {}): boolean {
  if (path === '') return opts.allowRoot === true
  if (path.length > 1024 || path.startsWith('/') || path.endsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export const BranchNameSchema = z.string().trim().refine(isValidBranchName, 'Not a valid branch name.')
export const RepoPathSchema = z.string().refine((p) => isValidRepoPath(p), 'Not a valid file path.')
export const RepoDirSchema = z.string().refine((p) => isValidRepoPath(p, { allowRoot: true }), 'Not a valid folder path.')
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'Not a git object id.')

// ─── Statuses ────────────────────────────────────────────────────────────────────────────────────

/** The repository as a whole: waiting for its first clone, syncing, usable, or the last sync failed. */
export const REPO_STATUSES = ['queued', 'syncing', 'ready', 'failed'] as const
export type RepoStatus = (typeof REPO_STATUSES)[number]

export const REPO_SYNC_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const
export type RepoSyncStatus = (typeof REPO_SYNC_STATUSES)[number]

/** Why a sync ran: linking the repo, the Sync button, opening a branch, after a commit, or resumed at startup. */
export const REPO_SYNC_TRIGGERS = ['link', 'manual', 'branch', 'commit', 'startup'] as const
export type RepoSyncTrigger = (typeof REPO_SYNC_TRIGGERS)[number]

/**
 * What the platform holds for one tracked file. Only `stored` files have their contents in the database (and can
 * be viewed and edited); the rest are listed with their size so the tree stays complete.
 */
export const REPO_FILE_STATUSES = ['stored', 'binary', 'too_large', 'non_utf8', 'secret', 'submodule', 'symlink'] as const
export type RepoFileStatus = (typeof REPO_FILE_STATUSES)[number]

export const REPO_FILE_STATUS_LABELS: Record<RepoFileStatus, string> = {
  stored: 'Text file',
  binary: 'Binary file — not stored',
  too_large: 'Too large to store',
  non_utf8: 'Not UTF-8 text — not stored',
  secret: 'Looks like a secret — contents never stored',
  submodule: 'Git submodule',
  symlink: 'Symbolic link',
}

/** Text files larger than this are listed but not stored (the API's REPO_MAX_FILE_BYTES may lower it). */
export const REPO_MAX_FILE_BYTES = 1024 * 1024

// ─── Repository ──────────────────────────────────────────────────────────────────────────────────

/** Empty strings become undefined, so a blank form field means "not given". */
const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))

/**
 * A repository to link: just its URL (and optionally the default branch). Access comes from the organisation's
 * Git connections (see connections.ts), set up once by an org admin — never entered per project.
 */
export const RepositoryInputSchema = z.object({
  url: z.string().trim().min(1, 'Enter the repository URL.').max(500),
  /** Branch to treat as the default; the remote's default branch when omitted. */
  defaultBranch: optionalTrimmed(250).pipe(BranchNameSchema.optional()),
  /** The Git connection the repository was picked from — used for it from then on (instead of matching by owner). */
  connectionId: z.string().uuid().optional(),
})
export type RepositoryInput = z.input<typeof RepositoryInputSchema>

/**
 * Link or update a project's repository. `token: null` drops a token stored on the project itself by an older
 * version, so the repository uses the Git connections like every other.
 */
export const UpdateRepositoryInputSchema = z.object({
  url: z.string().trim().min(1).max(500),
  token: z.null().optional(),
  defaultBranch: z.string().trim().max(250).nullable().optional(),
})
export type UpdateRepositoryInput = z.input<typeof UpdateRepositoryInputSchema>

export const RepoTestInputSchema = z.object({
  url: z.string().trim().min(1).max(500),
})
export type RepoTestInput = z.input<typeof RepoTestInputSchema>

export const RepoTestResultSchema = z.object({
  provider: z.enum(REPO_PROVIDERS),
  displayName: z.string(),
  defaultBranch: z.string().nullable(),
  branchCount: z.number().int(),
  /** Which credential reached the repository (a Git connection, or none for a public one). */
  credential: RepoCredentialSchema,
})
export type RepoTestResult = z.infer<typeof RepoTestResultSchema>

export const RepoBranchStatsSchema = z.object({
  name: z.string(),
  sha: z.string(),
  files: z.number().int(),
  stored: z.number().int(),
  added: z.number().int(),
  changed: z.number().int(),
  removed: z.number().int(),
  ignored: z.number().int(),
  /** Up to 50 of the paths left out because of .gitignore. */
  ignoredSamples: z.array(z.string()),
  /** Files listed but not stored, by reason. */
  notStored: z.record(z.number().int()),
})
export type RepoBranchStats = z.infer<typeof RepoBranchStatsSchema>

export const RepoCatalogStatsSchema = z.object({
  agents: z.number().int(),
  skills: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
})
export type RepoCatalogStats = z.infer<typeof RepoCatalogStatsSchema>

export const RepoSyncStatsSchema = z.object({
  branches: z.array(RepoBranchStatsSchema),
  /** Agents and skills imported from the default branch; null when it did not change. */
  catalog: RepoCatalogStatsSchema.nullable(),
})
export type RepoSyncStats = z.infer<typeof RepoSyncStatsSchema>

export const RepoSyncSchema = z.object({
  id: z.string().uuid(),
  trigger: z.enum(REPO_SYNC_TRIGGERS),
  /** The one branch this sync was for; null for a full sync. */
  branch: z.string().nullable(),
  status: z.enum(REPO_SYNC_STATUSES),
  stats: RepoSyncStatsSchema.nullable(),
  error: z.string().nullable(),
  requestedBy: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type RepoSync = z.infer<typeof RepoSyncSchema>

export const ProjectRepositorySchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(REPO_PROVIDERS),
  remoteUrl: z.string(),
  webUrl: z.string().nullable(),
  displayName: z.string(),
  defaultBranch: z.string().nullable(),
  status: z.enum(REPO_STATUSES),
  /** Whether a token is stored on the project itself (older repositories; new ones use Git connections). */
  hasToken: z.boolean(),
  /** Last 4 characters of that project token, for recognition. */
  tokenHint: z.string().nullable(),
  /** How the platform authenticates to this repository right now. */
  credential: RepoCredentialSchema,
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** The sync waiting or running right now, if any. */
  activeSync: RepoSyncSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ProjectRepository = z.infer<typeof ProjectRepositorySchema>

/** What the project card needs: which host, and whether the copy is usable. */
export const RepositoryBadgeSchema = z.object({
  provider: z.enum(REPO_PROVIDERS),
  status: z.enum(REPO_STATUSES),
  displayName: z.string(),
})
export type RepositoryBadge = z.infer<typeof RepositoryBadgeSchema>

// ─── Branches, tree, files ───────────────────────────────────────────────────────────────────────

export const RepoCommitInfoSchema = z.object({
  sha: z.string(),
  message: z.string(),
  author: z.string(),
  committedAt: z.string().nullable(),
})
export type RepoCommitInfo = z.infer<typeof RepoCommitInfoSchema>

export const RepoBranchSchema = z.object({
  name: z.string(),
  isDefault: z.boolean(),
  /** Tip of the branch on the remote, as of the last sync. */
  remoteSha: z.string(),
  /** The commit whose files the platform holds; null until the branch is first opened. */
  indexedSha: z.string().nullable(),
  indexedAt: z.string().nullable(),
  /** A sync for this branch is waiting or running. */
  indexing: z.boolean(),
  commit: RepoCommitInfoSchema.nullable(),
  fileCount: z.number().int(),
  ignoredCount: z.number().int(),
  /** The caller's unsaved-to-git edits on this branch. */
  myDraftCount: z.number().int(),
})
export type RepoBranch = z.infer<typeof RepoBranchSchema>

export const TreeEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int(),
  /** Null for folders. */
  status: z.enum(REPO_FILE_STATUSES).nullable(),
  /** The caller has a draft of this file (or, for a folder, of a file inside it). */
  hasDraft: z.boolean(),
  /**
   * How the file differs on a run's branch (Code page, run-branch view) — like VS Code's SCM decorations. For a
   * folder: the strongest change inside it.
   */
  change: z.enum(['added', 'modified', 'deleted', 'renamed']).nullable().optional(),
  /** For a folder on a run's branch: how many changed files are inside it. */
  changeCount: z.number().int().optional(),
})
export type TreeEntry = z.infer<typeof TreeEntrySchema>
export type TreeChange = NonNullable<TreeEntry['change']>

// ─── Run branches (a run's work, which lives only in the user's VS Code) ─────────────────────────

/** A workflow run's branch as the Code page lists it: what VS Code last reported the run changed. */
export const RunBranchSchema = z.object({
  runId: z.string().uuid(),
  branch: z.string(),
  /** `PAY-12`, or null for a quick fix. */
  storyKey: z.string().nullable(),
  workflowName: z.string(),
  status: z.string(),
  startedBy: z.string().nullable(),
  files: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  commits: z.number().int(),
  updatedAt: z.string(),
})
export type RunBranch = z.infer<typeof RunBranchSchema>

export const RunBranchFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  change: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
})
export type RunBranchFile = z.infer<typeof RunBranchFileSchema>

export const RunBranchDetailSchema = RunBranchSchema.extend({
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  /** The indexed branch the tree is overlaid on (the repository's default branch). */
  baseBranch: z.string().nullable(),
  changes: z.array(RunBranchFileSchema),
})
export type RunBranchDetail = z.infer<typeof RunBranchDetailSchema>

/** One changed file on a run's branch: its text before the run and now, or (when too large) only its patch. */
export const RunBranchFileContentSchema = RunBranchFileSchema.extend({
  original: z.string().nullable(),
  modified: z.string().nullable(),
  /** No full text was reported (too large / binary): `patch` is the file's part of the run's diff, if shared. */
  truncated: z.boolean(),
  patch: z.string().nullable(),
})
export type RunBranchFileContent = z.infer<typeof RunBranchFileContentSchema>

export const RepoPathsSchema = z.object({
  paths: z.array(z.string()),
  /** More files exist than were returned. */
  truncated: z.boolean(),
})
export type RepoPaths = z.infer<typeof RepoPathsSchema>

export const FileDraftSchema = z.object({
  branch: z.string(),
  path: z.string(),
  /** The blob the edit started from. */
  baseBlobSha: z.string(),
  content: z.string(),
  updatedAt: z.string(),
  /** The file changed on the branch since the edit started (base ≠ current). */
  stale: z.boolean(),
})
export type FileDraft = z.infer<typeof FileDraftSchema>

export const DraftSummarySchema = FileDraftSchema.omit({ content: true })
export type DraftSummary = z.infer<typeof DraftSummarySchema>

export const RepoFileSchema = z.object({
  branch: z.string(),
  path: z.string(),
  blobSha: z.string(),
  size: z.number().int(),
  /** Git file mode, e.g. `100644` or `100755`. */
  mode: z.string(),
  status: z.enum(REPO_FILE_STATUSES),
  /** File contents; null unless `status` is `stored`. */
  content: z.string().nullable(),
  /** Whether the CALLER may edit it (a stored text file and the `code.edit` permission). */
  editable: z.boolean(),
  /** The caller's draft of this file, if any. */
  draft: FileDraftSchema.nullable(),
  webUrl: z.string().nullable(),
})
export type RepoFile = z.infer<typeof RepoFileSchema>

/** Drafts are capped a little above the stored-file limit so an edit can grow a file. */
export const MAX_DRAFT_CHARS = 1_500_000

export const SaveDraftInputSchema = z.object({
  branch: BranchNameSchema,
  path: RepoPathSchema,
  content: z.string().max(MAX_DRAFT_CHARS, 'The file is too large to save.'),
  baseBlobSha: GitShaSchema,
})
export type SaveDraftInput = z.infer<typeof SaveDraftInputSchema>

export const CommitInputSchema = z.object({
  branch: BranchNameSchema,
  message: z.string().trim().min(1, 'Write a commit message.').max(2000),
  paths: z.array(RepoPathSchema).min(1, 'Pick at least one file.').max(50),
})
export type CommitInput = z.infer<typeof CommitInputSchema>

export const CommitResultSchema = z.object({
  sha: z.string(),
  branch: z.string(),
  paths: z.array(z.string()),
  webUrl: z.string().nullable(),
})
export type CommitResult = z.infer<typeof CommitResultSchema>

/** One file that changed on the branch since the draft was started. Sent in a 409's `details.conflicts`. */
export const CommitConflictSchema = z.object({
  path: z.string(),
  /** The file's blob on the branch now; null when it was deleted there. */
  remoteBlobSha: z.string().nullable(),
})
export type CommitConflict = z.infer<typeof CommitConflictSchema>

export const CommitConflictDetailsSchema = z.object({ conflicts: z.array(CommitConflictSchema) })

export const CreateBranchInputSchema = z.object({
  name: BranchNameSchema,
  from: BranchNameSchema,
})
export type CreateBranchInput = z.infer<typeof CreateBranchInputSchema>

// ─── Workspaces (blank projects, no remote) ──────────────────────────────────────────────────────

/** Add a file to a workspace — committed at once. */
export const CreateRepoFileInputSchema = z.object({
  branch: BranchNameSchema,
  path: RepoPathSchema,
  content: z.string().max(MAX_DRAFT_CHARS, 'The file is too large to save.').default(''),
})
export type CreateRepoFileInput = z.input<typeof CreateRepoFileInputSchema>

/** Remove a file from a workspace — committed at once. */
export const DeleteRepoFileInputSchema = z.object({
  branch: BranchNameSchema,
  path: RepoPathSchema,
})
export type DeleteRepoFileInput = z.infer<typeof DeleteRepoFileInputSchema>

const GITHUB_REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/

/** Turn a project name into a GitHub repository name ("Payments Portal" → "payments-portal"). */
export function suggestRepoName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase()
      .slice(0, 100) || 'workspace'
  )
}

/** Publish a workspace: create a GitHub repository with one of the organisation's Git connections and push to it. */
export const PublishWorkspaceInputSchema = z.object({
  connectionId: z.string().uuid(),
  /** GitHub user or organisation to create it under; the token's own account when omitted. */
  owner: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  name: z.string().trim().regex(GITHUB_REPO_NAME, 'Use letters, digits, - _ . (up to 100).'),
  private: z.boolean().default(true),
})
export type PublishWorkspaceInput = z.input<typeof PublishWorkspaceInputSchema>
