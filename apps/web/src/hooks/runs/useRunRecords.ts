'use client'

// Run records for the Runs tab and a run's page: the filtered runs table, one run in full, its diff (loaded when
// asked for), and the dashboard stats. Everything refreshes live as VS Code reports runs.

import type { Patch, PlatformEvent, ProjectRun, ProjectRunDetail, RunStats } from '@sdlc/contracts'
import { projectRunsChanged } from '@/hooks/common/liveFilters'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getRunDetail, getRunDiff, getRunStats, listProjectRuns, type RunFilters } from '@/service/runs.service'

/** The project's runs, narrowed on the server by kind, person or file. */
export function useRunList(key: string, filters: RunFilters): ApiResource<ProjectRun[]> {
  return useApiResource(() => listProjectRuns(key, filters), [key, filters.kind, filters.user, filters.file], projectRunsChanged(key))
}

/** One run, its record or its memory changed (memory a run wrote is captured after it ends). */
function runChanged(key: string, id: string) {
  return (e: PlatformEvent): boolean =>
    (e.type === 'work.changed' && e.projectKey === key && e.kind === 'run' && (e.runId === undefined || e.runId === id)) ||
    (e.type === 'memory.changed' && e.projectKey === key) ||
    (e.type === 'run.activity' && e.runId === id)
}

/** One run in full: steps, evaluations, changes, memory, context, attempt, feedback and AI summary. */
export function useRunDetail(key: string, id: string): ApiResource<ProjectRunDetail> {
  return useApiResource(() => getRunDetail(key, id), [key, id], runChanged(key, id))
}

/** The run's diff, once `load` is true (it can be large). */
export function useRunDiff(key: string, id: string, load: boolean, version: string | undefined): ApiResource<Patch | null> {
  return useApiResource(() => (load ? getRunDiff(key, id) : Promise.resolve(null)), [key, id, load, version])
}

export function useRunStats(key: string, days: number, user?: string): ApiResource<RunStats> {
  return useApiResource(() => getRunStats(key, days, user), [key, days, user], projectRunsChanged(key))
}
