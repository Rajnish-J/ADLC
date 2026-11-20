// The Code feature (linked repository, explorer, Monaco editor, drafts and commits), imported as `* as K`.

export type { DraftSummary, ProjectDetail, ProjectRepository, RepoBranch, RepoFile, TreeEntry } from '@sdlc/contracts'
export { AppError } from '@/appError'
export {
  commitDrafts,
  CommitConflictError,
  createBranch,
  createRepoFile,
  deleteRepoFile,
  publishWorkspace,
  disconnectRepository,
  discardDraft,
  openBranch,
  saveDraft,
  saveRepository,
  syncRepository,
  testProjectRepository,
  testRepository,
} from '@/service/code.service'
export { useBranches, useDrafts, useRepoFile, useRepository, useSyncs } from '@/hooks/code/useCode'
export { useCodeTree, type CodeTree } from '@/hooks/code/useCodeTree'
export { default as ProjectShell } from '@/components/project/ProjectShell'
export { default as CodeWorkbench } from '@/components/code/CodeWorkbench'
export { default as RepositoryBar } from '@/components/code/RepositoryBar'
export { default as RepositoryFields, EMPTY_REPOSITORY, repositoryInput, type RepositoryValues } from '@/components/code/RepositoryFields'
export { default as ProviderIcon } from '@/components/code/ProviderIcon'
export { default as PublishWorkspaceDialog } from '@/components/code/PublishWorkspaceDialog'
