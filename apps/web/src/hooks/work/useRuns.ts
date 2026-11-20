'use client'

import type { ProjectRun, ProjectRunDetail } from '@sdlc/contracts'
import { projectRunsChanged } from '@/hooks/common/liveFilters'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getRun, listRuns } from '@/service/work.service'

/** Every agent run in the project. Refreshes live as runs are reported from VS Code. */
export function useProjectRuns(key: string): ApiResource<ProjectRun[]> {
  return useApiResource(() => listRuns(key), [key], projectRunsChanged(key))
}

/** One run with its steps and evaluations (null id → nothing loaded). */
export function useProjectRun(key: string, id: string | null): ApiResource<ProjectRunDetail | null> {
  return useApiResource(() => (id ? getRun(key, id) : Promise.resolve(null)), [key, id], projectRunsChanged(key))
}
