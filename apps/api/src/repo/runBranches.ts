// A workflow run's branch on the Code page. The branch lives only in the user's VS Code (runs never push), so it is
// shown virtually: the repository's default branch, as indexed, with the files VS Code reported the run changed laid
// over it — added files injected, changed and deleted ones marked like VS Code's SCM decorations — and each changed
// file's before/after text (run_change_contents) for a side-by-side diff. Read-only: no drafts, no commits.

import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { ChangedFile, RunBranch, RunBranchDetail, RunBranchFile, RunBranchFileContent, TreeChange, TreeEntry } from '@sdlc/contracts'
import { loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import { projectRepositories, runChangeContents, runChanges, runs, stories, users } from '../db/schema'
import { HttpError, notFound } from '../http'
import { listTree } from './service'

const LIST_LIMIT = 40

/** A reported file status as the explorer marks it. */
export function changeOf(f: Pick<ChangedFile, 'status'>): TreeChange {
  switch (f.status) {
    case 'added':
    case 'untracked':
    case 'copied':
      return 'added'
    case 'deleted':
      return 'deleted'
    case 'renamed':
      return 'renamed'
    default:
      return 'modified'
  }
}

/** Which change a folder shows when it holds several (VS Code shows the most significant). */
const RANK: Record<TreeChange, number> = { deleted: 1, renamed: 2, added: 3, modified: 4 }

function toFile(f: ChangedFile): RunBranchFile {
  return { path: f.path, oldPath: f.oldPath ?? null, change: changeOf(f), additions: f.additions, deletions: f.deletions, binary: f.binary }
}

async function runRow(db: Db, access: ProjectAccess, runId: string) {
  const [row] = await db
    .select({ run: runs, changes: runChanges, storyNumber: stories.number, startedBy: users.displayName })
    .from(runChanges)
    .innerJoin(runs, eq(runs.id, runChanges.runId))
    .leftJoin(stories, eq(stories.id, runs.storyId))
    .leftJoin(users, eq(users.id, runs.userId))
    .where(and(eq(runChanges.runId, runId), eq(runChanges.projectId, access.project.id)))
    .limit(1)
  if (!row || !row.changes.branch) throw notFound('Run branch')
  return row
}

function summary(access: ProjectAccess, row: Awaited<ReturnType<typeof runRow>>): RunBranch {
  const c = row.changes
  return {
    runId: row.run.id,
    branch: c.branch ?? '',
    storyKey: row.storyNumber != null ? `${access.project.key}-${row.storyNumber}` : null,
    workflowName: row.run.workflowName,
    status: row.run.status,
    startedBy: row.startedBy ?? null,
    files: c.files.length,
    additions: c.additions,
    deletions: c.deletions,
    commits: c.commits.length,
    updatedAt: c.updatedAt.toISOString(),
  }
}

/** The project's run branches with reported changes, most recently updated first. */
export async function listRunBranches(db: Db, user: AuthUser, key: string): Promise<RunBranch[]> {
  const access = await loadProjectAccess(db, user, key)
  const rows = await db
    .select({ run: runs, changes: runChanges, storyNumber: stories.number, startedBy: users.displayName })
    .from(runChanges)
    .innerJoin(runs, eq(runs.id, runChanges.runId))
    .leftJoin(stories, eq(stories.id, runs.storyId))
    .leftJoin(users, eq(users.id, runs.userId))
    .where(and(eq(runChanges.projectId, access.project.id), isNotNull(runChanges.branch)))
    .orderBy(desc(runChanges.updatedAt))
    .limit(LIST_LIMIT)
  return rows.filter((r) => r.changes.files.length > 0).map((r) => summary(access, r))
}

export async function getRunBranch(db: Db, user: AuthUser, key: string, runId: string): Promise<RunBranchDetail> {
  const access = await loadProjectAccess(db, user, key)
  const row = await runRow(db, access, runId)
  const [repo] = await db
    .select({ defaultBranch: projectRepositories.defaultBranch })
    .from(projectRepositories)
    .where(eq(projectRepositories.projectId, access.project.id))
    .limit(1)
  return {
    ...summary(access, row),
    baseSha: row.changes.baseSha,
    headSha: row.changes.headSha,
    baseBranch: repo?.defaultBranch ?? null,
    changes: row.changes.files.map(toFile),
  }
}

/**
 * One folder of the run's branch: the default branch's entries in `dir`, marked with the run's changes, plus the
 * files and folders the run added there. A renamed file's old path shows as deleted.
 */
export function overlayTree(base: TreeEntry[], files: readonly ChangedFile[], dir: string): TreeEntry[] {
  const prefix = dir ? `${dir}/` : ''
  const marks = new Map<string, TreeChange>()
  for (const f of files) {
    marks.set(f.path, changeOf(f))
    if (f.oldPath && f.status === 'renamed') marks.set(f.oldPath, 'deleted')
  }
  const out = new Map(base.map((e) => [e.path, { ...e, change: null as TreeChange | null }]))
  for (const [path, change] of marks) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash < 0) {
      const existing = out.get(path)
      if (existing) existing.change = change
      else out.set(path, { path, name: rest, type: 'file', size: 0, status: 'stored', hasDraft: false, change })
    } else {
      const folder = `${prefix}${rest.slice(0, slash)}`
      if (!out.has(folder)) out.set(folder, { path: folder, name: rest.slice(0, slash), type: 'dir', size: 0, status: null, hasDraft: false, change: null })
    }
  }
  for (const entry of out.values()) {
    if (entry.type !== 'dir') continue
    const inside = [...marks].filter(([p]) => p.startsWith(`${entry.path}/`))
    if (inside.length === 0) continue
    entry.changeCount = inside.length
    entry.change = inside.map(([, c]) => c).sort((a, b) => RANK[b] - RANK[a])[0]
  }
  return [...out.values()].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1,
  )
}

export async function runBranchTree(db: Db, user: AuthUser, key: string, runId: string, dir: string): Promise<TreeEntry[]> {
  const access = await loadProjectAccess(db, user, key)
  const row = await runRow(db, access, runId)
  // Without a linked, indexed repository the run's own files still make a tree.
  const base = await listTree(db, user, key, undefined, dir).catch((err: unknown) => {
    if (err instanceof HttpError && err.statusCode < 500) return [] as TreeEntry[]
    throw err
  })
  return overlayTree(
    base.map((e) => ({ ...e, hasDraft: false })),
    row.changes.files,
    dir,
  )
}

/** The `diff --git` section of one file in the run's combined patch. */
export function patchSection(patch: string | null, path: string): string | null {
  if (!patch) return null
  const lines = patch.split('\n')
  let out: string[] | null = null
  for (const line of lines) {
    const header = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line)
    if (header) {
      if (out) break
      if (header[2] === path) out = [line]
    } else if (out) {
      out.push(line)
    }
  }
  return out ? out.join('\n').replace(/\n+$/, '') : null
}

export async function runBranchFile(db: Db, user: AuthUser, key: string, runId: string, path: string): Promise<RunBranchFileContent> {
  const access = await loadProjectAccess(db, user, key)
  const row = await runRow(db, access, runId)
  const file = row.changes.files.find((f) => f.path === path)
  if (!file) throw notFound('Changed file')
  const [content] = await db
    .select()
    .from(runChangeContents)
    .where(and(eq(runChangeContents.runId, row.run.id), eq(runChangeContents.path, path)))
    .limit(1)
  const truncated = !content || content.truncated
  return {
    ...toFile(file),
    original: content?.original ?? null,
    modified: content?.modified ?? null,
    truncated,
    patch: truncated ? patchSection(row.changes.patch, path) : null,
  }
}
