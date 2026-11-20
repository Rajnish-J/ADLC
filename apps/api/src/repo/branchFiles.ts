// Read an indexed branch straight from the database (no permission checks — callers check access first): the
// branch row, every stored file path, and the contents of chosen files. Used by the project profiler.

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { projectRepositories, repoBlobs, repoBranches, repoFiles } from '../db/schema'
import { HttpError } from '../http'

export type RepositoryRow = typeof projectRepositories.$inferSelect
export type BranchRecord = typeof repoBranches.$inferSelect

/** The project's linked repository, or null. */
export async function repositoryOfProject(db: Db, projectId: string): Promise<RepositoryRow | null> {
  const [repo] = await db.select().from(projectRepositories).where(eq(projectRepositories.projectId, projectId)).limit(1)
  return repo ?? null
}

/** An indexed branch of the repository (the default branch when `name` is omitted). 409 when it has no files yet. */
export async function indexedBranchOf(db: Db, repo: RepositoryRow, name?: string | null): Promise<BranchRecord> {
  const branchName = name || repo.defaultBranch
  if (!branchName) throw new HttpError(409, 'repository_empty', 'The repository has no branches yet.')
  const [branch] = await db
    .select()
    .from(repoBranches)
    .where(and(eq(repoBranches.repositoryId, repo.id), eq(repoBranches.name, branchName)))
    .limit(1)
  if (!branch) throw new HttpError(404, 'not_found', `Branch "${branchName}" not found.`)
  if (!branch.indexedSha) throw new HttpError(409, 'branch_not_indexed', `The branch "${branchName}" hasn't been opened yet — open it to load its files.`)
  return branch
}

/** Every file path on the branch (stored or not — the profile counts them all), sorted. */
export async function branchFilePaths(db: Db, branchId: string): Promise<string[]> {
  const rows = await db
    .select({ path: repoFiles.path })
    .from(repoFiles)
    .where(and(eq(repoFiles.branchId, branchId), eq(repoFiles.type, 'file')))
  return rows.map((r) => r.path).sort()
}

/** The text of the given files on the branch; files without stored contents (binary, too large, secret) are left out. */
export async function readBranchFiles(db: Db, repositoryId: string, branchId: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (paths.length === 0) return out
  const files: Array<{ path: string; blobSha: string | null }> = []
  for (let i = 0; i < paths.length; i += 500) {
    files.push(
      ...(await db
        .select({ path: repoFiles.path, blobSha: repoFiles.blobSha })
        .from(repoFiles)
        .where(and(eq(repoFiles.branchId, branchId), eq(repoFiles.status, 'stored'), inArray(repoFiles.path, paths.slice(i, i + 500))))),
    )
  }
  const shas = [...new Set(files.map((f) => f.blobSha).filter((s): s is string => Boolean(s)))]
  const contents = new Map<string, string>()
  for (let i = 0; i < shas.length; i += 500) {
    const rows = await db
      .select({ sha: repoBlobs.sha, content: repoBlobs.content })
      .from(repoBlobs)
      .where(and(eq(repoBlobs.repositoryId, repositoryId), inArray(repoBlobs.sha, shas.slice(i, i + 500))))
    for (const r of rows) contents.set(r.sha, r.content)
  }
  for (const f of files) {
    const text = f.blobSha ? contents.get(f.blobSha) : undefined
    if (text !== undefined) out.set(f.path, text)
  }
  return out
}
