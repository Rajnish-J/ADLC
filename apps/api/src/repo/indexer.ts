// Sync: bring the platform's copy of a repository up to date.
//   1. ls-remote → every branch and its tip (no download).
//   2. Pick the branches to (re)index: the default branch plus any branch someone opened, when its tip moved.
//   3. One shallow fetch (--depth 1) into a temp bare repository — nothing is checked out, so ignored files are
//      never written to disk.
//   4. Per branch: ls-tree → apply .gitignore / default / secret rules → read only blobs the database doesn't have
//      yet → store text blobs → replace the branch's file rows by diff.
//   5. Import agents and skills from the default branch, then drop blobs nothing refers to any more.

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { RepoBranchStats, RepoFileStatus, RepoSyncStats, RepoSyncTrigger } from '@sdlc/contracts'
import { repoBlobs, repoBranches, repoFileDrafts, repoFiles, projectRepositories } from '../db/schema'
import type { Db, Tx } from '../db/client'
import { importRepoCatalog, type CatalogImportResult } from './catalogImport'
import { catFileBatch, gitText, lsRemote, parseLsTree, runGit, type TreeEntryRaw } from './git'
import { gitignoreDir, IgnoreRules } from './ignoreRules'
import { remoteOptionsFor } from './connections'
import { withTempDir, type RepoRow, type RepoRuntime } from './runtime'

export type BranchRow = typeof repoBranches.$inferSelect
type FileRow = typeof repoFiles.$inferInsert

export interface SyncJob {
  id: string
  repositoryId: string
  trigger: RepoSyncTrigger
  /** Index just this branch; null for a full sync. */
  branch: string | null
  requestedBy: string | null
  via: string
}

export interface SyncResult {
  stats: RepoSyncStats
  catalog: CatalogImportResult | null
}

const IGNORED_SAMPLE_LIMIT = 50
/** Bytes of blob content read per `cat-file --batch` call. */
const READ_BATCH_BYTES = 16 * 1024 * 1024
const READ_BATCH_OBJECTS = 2000
const INSERT_BATCH_BYTES = 8 * 1024 * 1024
const INSERT_BATCH_ROWS = 500
const IN_CHUNK = 5000

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** NUL bytes mean binary (and Postgres text can't hold them anyway). */
export function looksBinary(buf: Buffer): boolean {
  return buf.includes(0)
}

/** Strict UTF-8 decode, keeping a BOM so a committed edit writes the same bytes back. Null if not valid UTF-8. */
export function decodeText(buf: Buffer): string | null {
  try {
    return utf8.decode(buf)
  } catch {
    return null
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** The remote's default branch, or a sensible guess when it advertises none. */
function pickDefault(head: string | null, branches: Map<string, string>): string | null {
  if (head && branches.has(head)) return head
  for (const name of ['main', 'master', 'develop', 'trunk']) if (branches.has(name)) return name
  return [...branches.keys()].sort()[0] ?? null
}

export async function runSync(rt: RepoRuntime, job: SyncJob): Promise<SyncResult> {
  const [repo] = await rt.db.select().from(projectRepositories).where(eq(projectRepositories.id, job.repositoryId)).limit(1)
  if (!repo) throw new Error('The repository was disconnected.')
  const opts = await remoteOptionsFor(rt, repo)

  const remote = await lsRemote(repo.remoteUrl, opts)
  const defaultBranch = repo.defaultBranchPinned && repo.defaultBranch ? repo.defaultBranch : pickDefault(remote.head, remote.branches)
  if (repo.defaultBranchPinned && repo.defaultBranch && !remote.branches.has(repo.defaultBranch)) {
    throw new Error(`The default branch "${repo.defaultBranch}" doesn't exist on the remote.`)
  }

  const branches = await reconcileBranches(rt.db, repo, remote.branches, defaultBranch)
  let toIndex: BranchRow[]
  if (job.branch) {
    const b = branches.find((x) => x.name === job.branch)
    if (!b) throw new Error(`The branch "${job.branch}" no longer exists on the remote.`)
    toIndex = b.indexedSha === b.remoteSha ? [] : [b]
  } else {
    toIndex = branches.filter((b) => (b.isDefault || b.indexedSha) && b.indexedSha !== b.remoteSha)
  }

  const stats: RepoBranchStats[] = []
  if (toIndex.length > 0) {
    await withTempDir(rt, 'sync', async (dir) => {
      await runGit(['init', '--bare', '-q', dir], { timeoutMs: 60_000 })
      const refspecs = toIndex.map((b, i) => `+refs/heads/${b.name}:refs/sdlc/${i}`)
      await runGit(['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--quiet', repo.remoteUrl, ...refspecs], { ...opts, cwd: dir })
      for (const [i, b] of toIndex.entries()) {
        stats.push(await indexBranch(rt, repo, b, `refs/sdlc/${i}`, dir))
      }
    })
  }

  // Agents and skills follow the default branch. A full sync always re-imports (cheap: only definition files are
  // read), so the catalog also catches up after the importer itself improves.
  let catalog: CatalogImportResult | null = null
  const defaultRow = (await rt.db.select().from(repoBranches).where(eq(repoBranches.repositoryId, repo.id))).find((b) => b.isDefault)
  const defaultChanged = toIndex.some((b) => b.isDefault)
  if (defaultRow?.indexedSha && (job.branch === null || defaultChanged)) {
    catalog = await importRepoCatalog(rt, { repo, branch: defaultRow, requestedBy: job.requestedBy, via: job.via })
  } else if (!defaultRow) {
    // An empty repository (no branches): nothing in the catalog may come from it.
    catalog = await importRepoCatalog(rt, { repo, branch: null, requestedBy: job.requestedBy, via: job.via })
  }

  await collectGarbage(rt.db, repo.id)
  return { stats: { branches: stats, catalog: catalog?.stats ?? null }, catalog }
}

/** Mirror the remote's branch list: add new branches, move tips, drop deleted ones (with their files and drafts). */
async function reconcileBranches(db: Db, repo: RepoRow, remote: Map<string, string>, defaultBranch: string | null): Promise<BranchRow[]> {
  return db.transaction(async (tx) => {
    const existing = await tx.select().from(repoBranches).where(eq(repoBranches.repositoryId, repo.id))
    const gone = existing.filter((b) => !remote.has(b.name))
    if (gone.length > 0) {
      await tx.delete(repoBranches).where(inArray(repoBranches.id, gone.map((b) => b.id)))
      await tx
        .delete(repoFileDrafts)
        .where(and(eq(repoFileDrafts.repositoryId, repo.id), inArray(repoFileDrafts.branch, gone.map((b) => b.name))))
    }
    const byName = new Map(existing.map((b) => [b.name, b]))
    for (const [name, sha] of remote) {
      const isDefault = name === defaultBranch
      const row = byName.get(name)
      if (!row) {
        await tx.insert(repoBranches).values({ repositoryId: repo.id, name, remoteSha: sha, isDefault })
      } else if (row.remoteSha !== sha || row.isDefault !== isDefault) {
        await tx.update(repoBranches).set({ remoteSha: sha, isDefault }).where(eq(repoBranches.id, row.id))
      }
    }
    await tx
      .update(projectRepositories)
      .set({ defaultBranch, updatedAt: new Date() })
      .where(eq(projectRepositories.id, repo.id))
    return tx.select().from(repoBranches).where(eq(repoBranches.repositoryId, repo.id))
  })
}

/** Statuses already decided for these blobs (from any branch of this repository), so they aren't read again. */
async function knownBlobStatuses(db: Db, repositoryId: string, shas: string[]): Promise<Map<string, RepoFileStatus>> {
  const known = new Map<string, RepoFileStatus>()
  for (const part of chunk(shas, IN_CHUNK)) {
    const stored = await db
      .select({ sha: repoBlobs.sha })
      .from(repoBlobs)
      .where(and(eq(repoBlobs.repositoryId, repositoryId), inArray(repoBlobs.sha, part)))
    for (const r of stored) known.set(r.sha, 'stored')
    const decided = await db
      .selectDistinct({ sha: repoFiles.blobSha, status: repoFiles.status })
      .from(repoFiles)
      .innerJoin(repoBranches, eq(repoBranches.id, repoFiles.branchId))
      .where(
        and(
          eq(repoBranches.repositoryId, repositoryId),
          inArray(repoFiles.blobSha, part),
          inArray(repoFiles.status, ['binary', 'non_utf8']),
        ),
      )
    for (const r of decided) if (r.sha && r.status && !known.has(r.sha)) known.set(r.sha, r.status)
  }
  return known
}

async function indexBranch(rt: RepoRuntime, repo: RepoRow, branch: BranchRow, ref: string, dir: string): Promise<RepoBranchStats> {
  const local = { cwd: dir, timeoutMs: 5 * 60_000 }
  const sha = (await gitText(['rev-parse', '--verify', `${ref}^{commit}`], local)).trim()
  const [, author, committedAt, subject] = (await gitText(['log', '-1', '--format=%H%x00%an%x00%cI%x00%s', sha], local)).trim().split('\0')
  const entries = parseLsTree((await runGit(['ls-tree', '-r', '-l', '-z', '--full-tree', sha], local)).stdout)

  // .gitignore files of this tree (skipping absurdly large ones).
  const gitignoreEntries = entries.filter((e) => e.type === 'blob' && gitignoreDir(e.path) !== null && e.size <= 1024 * 1024)
  const gitignoreBlobs = await catFileBatch(dir, [...new Set(gitignoreEntries.map((e) => e.sha))])
  const rules = new IgnoreRules(
    new Map(gitignoreEntries.map((e) => [gitignoreDir(e.path) as string, gitignoreBlobs.get(e.sha)?.toString('utf8') ?? ''])),
  )

  let ignored = 0
  const ignoredSamples: string[] = []
  const kept: Array<{ e: TreeEntryRaw; status: RepoFileStatus | null }> = []
  for (const e of entries) {
    if (e.type === 'tree') continue
    const c = rules.classify(e.path)
    if (c === 'ignored') {
      ignored++
      if (ignoredSamples.length < IGNORED_SAMPLE_LIMIT) ignoredSamples.push(e.path)
      continue
    }
    let status: RepoFileStatus | null = null
    if (e.type === 'commit') status = 'submodule'
    else if (e.mode === '120000') status = 'symlink'
    else if (c === 'secret') status = 'secret'
    else if (e.size > rt.maxFileBytes) status = 'too_large'
    kept.push({ e, status })
  }
  if (kept.length > rt.maxFiles) {
    throw new Error(`The branch "${branch.name}" has ${kept.length} files after .gitignore — more than the limit of ${rt.maxFiles}.`)
  }

  // Decide text / binary for the remaining files, reading only blobs the database doesn't know yet.
  const pending = [...new Set(kept.filter((k) => k.status === null).map((k) => k.e.sha))]
  const known = await knownBlobStatuses(rt.db, repo.id, pending)
  const sizes = new Map(kept.map((k) => [k.e.sha, k.e.size]))
  const unknown = pending.filter((s) => !known.has(s))
  let batch: string[] = []
  let batchBytes = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const blobs = await catFileBatch(dir, batch)
    const rows: Array<typeof repoBlobs.$inferInsert> = []
    for (const s of batch) {
      const buf = blobs.get(s)
      if (!buf) continue
      if (looksBinary(buf)) {
        known.set(s, 'binary')
        continue
      }
      const text = decodeText(buf)
      if (text === null) {
        known.set(s, 'non_utf8')
        continue
      }
      known.set(s, 'stored')
      rows.push({ repositoryId: repo.id, sha: s, size: buf.length, content: text })
    }
    await insertBlobs(rt.db, rows)
    batch = []
    batchBytes = 0
  }
  for (const s of unknown) {
    batch.push(s)
    batchBytes += sizes.get(s) ?? 0
    if (batchBytes >= READ_BATCH_BYTES || batch.length >= READ_BATCH_OBJECTS) await flush()
  }
  await flush()

  // File rows, plus a row for every folder that holds a kept file.
  const rows = new Map<string, FileRow>()
  for (const { e, status } of kept) {
    const parts = e.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const path = parts.slice(0, i).join('/')
      if (!rows.has(path)) {
        rows.set(path, { branchId: branch.id, path, dir: parts.slice(0, i - 1).join('/'), name: parts[i - 1], type: 'dir', mode: '040000', blobSha: null, size: 0, status: null })
      }
    }
    rows.set(e.path, {
      branchId: branch.id,
      path: e.path,
      dir: parts.slice(0, -1).join('/'),
      name: parts[parts.length - 1],
      type: 'file',
      mode: e.mode,
      blobSha: e.sha,
      size: e.size,
      status: status ?? known.get(e.sha) ?? 'binary',
    })
  }

  const diff = await rt.db.transaction(async (tx) => {
    const d = await replaceBranchFiles(tx, branch.id, rows)
    await tx
      .update(repoBranches)
      .set({
        indexedSha: sha,
        indexedAt: new Date(),
        remoteSha: sha,
        commitMessage: subject ?? null,
        commitAuthor: author ?? null,
        committedAt: committedAt ? new Date(committedAt) : null,
        fileCount: kept.length,
        ignoredCount: ignored,
      })
      .where(eq(repoBranches.id, branch.id))
    return d
  })

  const notStored: Record<string, number> = {}
  let stored = 0
  for (const r of rows.values()) {
    if (r.type !== 'file') continue
    if (r.status === 'stored') stored++
    else notStored[r.status as string] = (notStored[r.status as string] ?? 0) + 1
  }
  return { name: branch.name, sha, files: kept.length, stored, ...diff, ignored, ignoredSamples, notStored }
}

async function insertBlobs(db: Db, rows: Array<typeof repoBlobs.$inferInsert>): Promise<void> {
  let part: typeof rows = []
  let bytes = 0
  for (const r of rows) {
    part.push(r)
    bytes += r.size
    if (part.length >= INSERT_BATCH_ROWS || bytes >= INSERT_BATCH_BYTES) {
      await db.insert(repoBlobs).values(part).onConflictDoNothing()
      part = []
      bytes = 0
    }
  }
  if (part.length > 0) await db.insert(repoBlobs).values(part).onConflictDoNothing()
}

/** Write the branch's new tree as a diff against what is stored: only added/changed rows are written. */
async function replaceBranchFiles(tx: Tx, branchId: string, next: Map<string, FileRow>): Promise<{ added: number; changed: number; removed: number }> {
  const current = await tx
    .select({ path: repoFiles.path, type: repoFiles.type, blobSha: repoFiles.blobSha, status: repoFiles.status, mode: repoFiles.mode })
    .from(repoFiles)
    .where(eq(repoFiles.branchId, branchId))
  const byPath = new Map(current.map((r) => [r.path, r]))
  const removed = current.filter((r) => !next.has(r.path)).map((r) => r.path)
  const upserts: FileRow[] = []
  let added = 0
  let changed = 0
  for (const row of next.values()) {
    const cur = byPath.get(row.path)
    if (!cur) {
      upserts.push(row)
      if (row.type === 'file') added++
    } else if (cur.type !== row.type || cur.blobSha !== row.blobSha || cur.status !== row.status || cur.mode !== row.mode) {
      upserts.push(row)
      if (row.type === 'file') changed++
    }
  }
  const removedFiles = current.filter((r) => !next.has(r.path) && r.type === 'file').length
  for (const part of chunk(removed, IN_CHUNK)) {
    await tx.delete(repoFiles).where(and(eq(repoFiles.branchId, branchId), inArray(repoFiles.path, part)))
  }
  for (const part of chunk(upserts, 1000)) {
    await tx
      .insert(repoFiles)
      .values(part)
      .onConflictDoUpdate({
        target: [repoFiles.branchId, repoFiles.path],
        set: {
          dir: sql.raw('excluded.dir'),
          name: sql.raw('excluded.name'),
          type: sql.raw('excluded.type'),
          mode: sql.raw('excluded.mode'),
          blobSha: sql.raw('excluded.blob_sha'),
          size: sql.raw('excluded.size'),
          status: sql.raw('excluded.status'),
        },
      })
  }
  return { added, changed, removed: removedFiles }
}

/** Drop blobs that no branch's file and no draft refers to. */
export async function collectGarbage(db: Db, repositoryId: string): Promise<void> {
  await db.execute(sql`
    delete from repo_blobs b
    where b.repository_id = ${repositoryId}
      and not exists (
        select 1 from repo_files f join repo_branches br on br.id = f.branch_id
        where br.repository_id = ${repositoryId} and f.blob_sha = b.sha)
      and not exists (
        select 1 from repo_file_drafts d where d.repository_id = ${repositoryId} and d.base_blob_sha = b.sha)`)
}
