// The project's linked repository and its code: link / test / sync / disconnect, branches, folders, files, the
// caller's own drafts, and commits. Branch names travel as a query parameter because they contain slashes.

import { z } from 'zod'
import {
  CommitConflictDetailsSchema,
  CommitResultSchema,
  DraftSummarySchema,
  FileDraftSchema,
  ProjectRepositorySchema,
  RepoBranchSchema,
  RepoFileSchema,
  RepoPathsSchema,
  RepoSyncSchema,
  RepoTestResultSchema,
  TreeEntrySchema,
  RunBranchDetailSchema,
  RunBranchFileContentSchema,
  RunBranchSchema,
  type RunBranch,
  type RunBranchDetail,
  type RunBranchFileContent,
  type CommitConflict,
  type CommitInput,
  type CommitResult,
  type CreateBranchInput,
  type CreateRepoFileInput,
  type DraftSummary,
  type FileDraft,
  type ProjectRepository,
  type PublishWorkspaceInput,
  type RepoBranch,
  type RepoFile,
  type RepoPaths,
  type RepoSync,
  type RepoTestInput,
  type RepoTestResult,
  type SaveDraftInput,
  type TreeEntry,
  type UpdateRepositoryInput,
} from '@sdlc/contracts'
import { AppError } from '@/appError'
import { apiCommand, apiRequest } from './http'

const projectPath = (key: string): string => `/projects/${encodeURIComponent(key)}`

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v)
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** A commit refused because files changed on the branch since the edits started. */
export class CommitConflictError extends AppError {
  constructor(
    message: string,
    readonly conflicts: CommitConflict[],
  ) {
    super(message, undefined, 409, 'commit_conflict')
    this.name = 'CommitConflictError'
  }
}

// ─── Repository ──────────────────────────────────────────────────────────────────────────────────

export function getRepository(key: string): Promise<ProjectRepository | null> {
  return apiRequest(`${projectPath(key)}/repository`, ProjectRepositorySchema.nullable())
}

/** Check a URL and token before a project exists (create-project dialog). */
export function testRepository(input: RepoTestInput): Promise<RepoTestResult> {
  return apiRequest('/repositories/test', RepoTestResultSchema, { method: 'POST', body: input })
}

/** Check a URL and token for an existing project (a blank token uses the stored one). */
export function testProjectRepository(key: string, input: RepoTestInput): Promise<RepoTestResult> {
  return apiRequest(`${projectPath(key)}/repository/test`, RepoTestResultSchema, { method: 'POST', body: input })
}

export function saveRepository(key: string, input: UpdateRepositoryInput): Promise<ProjectRepository> {
  return apiRequest(`${projectPath(key)}/repository`, ProjectRepositorySchema, { method: 'PUT', body: input })
}

export function disconnectRepository(key: string): Promise<void> {
  return apiCommand(`${projectPath(key)}/repository`, { method: 'DELETE' })
}

/** Publish a workspace to a new GitHub repository; the project then syncs with it like any linked repository. */
export function publishWorkspace(key: string, input: PublishWorkspaceInput): Promise<ProjectRepository> {
  return apiRequest(`${projectPath(key)}/repository/publish`, ProjectRepositorySchema, { method: 'POST', body: input })
}

export function syncRepository(key: string): Promise<RepoSync> {
  return apiRequest(`${projectPath(key)}/repository/sync`, RepoSyncSchema, { method: 'POST' })
}

export function listSyncs(key: string): Promise<RepoSync[]> {
  return apiRequest(`${projectPath(key)}/repository/syncs`, z.array(RepoSyncSchema))
}

// ─── Branches ────────────────────────────────────────────────────────────────────────────────────

export function listBranches(key: string): Promise<RepoBranch[]> {
  return apiRequest(`${projectPath(key)}/code/branches`, z.array(RepoBranchSchema))
}

/** Load a branch's files; null when they are already up to date. */
export function openBranch(key: string, branch: string): Promise<RepoSync | null> {
  return apiRequest(`${projectPath(key)}/code/branches/index${query({ branch })}`, RepoSyncSchema.nullable(), { method: 'POST' })
}

export function createBranch(key: string, input: CreateBranchInput): Promise<void> {
  return apiCommand(`${projectPath(key)}/code/branches`, { method: 'POST', body: input })
}

// ─── Tree & files ────────────────────────────────────────────────────────────────────────────────

export function listTree(key: string, branch: string, path: string): Promise<TreeEntry[]> {
  return apiRequest(`${projectPath(key)}/code/tree${query({ branch, path })}`, z.array(TreeEntrySchema))
}

export function listPaths(key: string, branch: string): Promise<RepoPaths> {
  return apiRequest(`${projectPath(key)}/code/paths${query({ branch })}`, RepoPathsSchema)
}

export function getFile(key: string, branch: string, path: string): Promise<RepoFile> {
  return apiRequest(`${projectPath(key)}/code/file${query({ branch, path })}`, RepoFileSchema)
}

/** Add a file to a workspace (committed at once). */
export function createRepoFile(key: string, input: CreateRepoFileInput): Promise<CommitResult> {
  return apiRequest(`${projectPath(key)}/code/files`, CommitResultSchema, { method: 'POST', body: input })
}

/** Delete a file from a workspace (committed at once). */
export function deleteRepoFile(key: string, branch: string, path: string): Promise<CommitResult> {
  return apiRequest(`${projectPath(key)}/code/files${query({ branch, path })}`, CommitResultSchema, { method: 'DELETE' })
}

// ─── Drafts & commits ────────────────────────────────────────────────────────────────────────────

export function listDrafts(key: string, branch: string): Promise<DraftSummary[]> {
  return apiRequest(`${projectPath(key)}/code/drafts${query({ branch })}`, z.array(DraftSummarySchema))
}

export function saveDraft(key: string, input: SaveDraftInput): Promise<FileDraft> {
  return apiRequest(`${projectPath(key)}/code/drafts`, FileDraftSchema, { method: 'PUT', body: input })
}

export function discardDraft(key: string, branch: string, path: string): Promise<void> {
  return apiCommand(`${projectPath(key)}/code/drafts${query({ branch, path })}`, { method: 'DELETE' })
}

/** Commit drafts to their branch. A 409 with conflicting files becomes a CommitConflictError. */
export async function commitDrafts(key: string, input: CommitInput): Promise<CommitResult> {
  try {
    return await apiRequest(`${projectPath(key)}/code/commits`, CommitResultSchema, { method: 'POST', body: input })
  } catch (err) {
    if (err instanceof AppError && err.code === 'commit_conflict') {
      const details = CommitConflictDetailsSchema.safeParse(err.details)
      throw new CommitConflictError(err.message, details.success ? details.data.conflicts : [])
    }
    throw err
  }
}

// ─── Run branches: a workflow run's work in VS Code (never pushed), over the default branch ───────

export function listRunBranches(key: string): Promise<RunBranch[]> {
  return apiRequest(`${projectPath(key)}/code/run-branches`, z.array(RunBranchSchema))
}

export function getRunBranch(key: string, runId: string): Promise<RunBranchDetail> {
  return apiRequest(`${projectPath(key)}/code/run-branches/${encodeURIComponent(runId)}`, RunBranchDetailSchema)
}

export function listRunBranchTree(key: string, runId: string, path: string): Promise<TreeEntry[]> {
  return apiRequest(`${projectPath(key)}/code/run-branches/${encodeURIComponent(runId)}/tree${query({ path })}`, z.array(TreeEntrySchema))
}

export function getRunBranchFile(key: string, runId: string, path: string): Promise<RunBranchFileContent> {
  return apiRequest(`${projectPath(key)}/code/run-branches/${encodeURIComponent(runId)}/file${query({ path })}`, RunBranchFileContentSchema)
}
