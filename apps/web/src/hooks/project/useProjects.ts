'use client'

import type { ProjectDetail, ProjectSummary } from '@sdlc/contracts'
import { storiesOrProjectChanged } from '@/hooks/common/liveFilters'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getProject, listProjects } from '@/service/project.service'

/** Every project the user can see, with live story counts. */
export function useProjects(): ApiResource<ProjectSummary[]> {
  return useApiResource(listProjects, [])
}

/** One project's detail: members, the caller's role and permissions. */
export function useProject(key: string): ApiResource<ProjectDetail> {
  return useApiResource(() => getProject(key), [key], storiesOrProjectChanged(key))
}
