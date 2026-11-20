'use client'

// Data hooks for the Code page. Each refetches when the repository (or the branch it shows) changes.

import type { DraftSummary, ProjectRepository, RepoBranch, RepoFile, RepoSync } from '@sdlc/contracts'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { repoChanged } from '@/hooks/common/liveFilters'
import { getFile, getRepository, listBranches, listDrafts, listSyncs } from '@/service/code.service'

export function useRepository(key: string): ApiResource<ProjectRepository | null> {
  return useApiResource(() => getRepository(key), [key], repoChanged(key))
}

/** Branches of the linked repository; `enabled` false skips the call (no repository yet). */
export function useBranches(key: string, enabled: boolean): ApiResource<RepoBranch[]> {
  return useApiResource(() => (enabled ? listBranches(key) : Promise.resolve([])), [key, enabled], repoChanged(key))
}

export function useRepoFile(key: string, branch: string, path: string | null): ApiResource<RepoFile | null> {
  return useApiResource(() => (path ? getFile(key, branch, path) : Promise.resolve(null)), [key, branch, path], repoChanged(key, branch))
}

/** The caller's own drafts on a branch (empty for people who can't edit). */
export function useDrafts(key: string, branch: string, enabled: boolean): ApiResource<DraftSummary[]> {
  return useApiResource(() => (enabled ? listDrafts(key, branch) : Promise.resolve([])), [key, branch, enabled], repoChanged(key, branch))
}

export function useSyncs(key: string, enabled: boolean): ApiResource<RepoSync[]> {
  return useApiResource(() => (enabled ? listSyncs(key) : Promise.resolve([])), [key, enabled], repoChanged(key))
}
