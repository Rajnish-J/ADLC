'use client'

// Harness runs: the harnesses you can start a run in right now (installed in your online VS Code windows and allowed
// by the project), a run's live activity log, and a story's tasks.

import { useMemo } from 'react'
import {
  effectiveEngine,
  readProjectSettings,
  startableHarnesses,
  type ClientPresence,
  type PlatformEvent,
  type ProjectSettings,
  type RunEventsPage,
  type StartableHarness,
  type StoryTask,
} from '@sdlc/contracts'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { useMySettings } from '@/hooks/settings/useSettings'
import { listRunEvents, listTasks } from '@/service/harnessRun.service'

export interface Harnesses {
  /** Only harnesses installed in an online VS Code window of yours that the project allows. */
  startable: StartableHarness[]
  /** Your online VS Code windows. */
  clients: ClientPresence[]
  /** The harness to preselect: your preference if startable, else the project default, else the first. */
  preferred: string | null
  settings: ProjectSettings
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useHarnesses(projectSettings: unknown): Harnesses {
  const { data, loading, error, reload } = useMySettings()
  return useMemo(() => {
    const settings = readProjectSettings(projectSettings)
    const clients = (data?.clients ?? []).filter((c) => c.online)
    const startable = startableHarnesses(clients, settings)
    const wanted = effectiveEngine(data?.preferences.agentEngine ?? null, settings)
    const preferred = startable.find((h) => h.engine === wanted)?.engine ?? startable[0]?.engine ?? null
    return { startable, clients, preferred, settings, loading, error: error?.message ?? null, reload }
  }, [data, loading, error, reload, projectSettings])
}

const runActivity = (runId: string | null) => (e: PlatformEvent) =>
  (e.type === 'run.activity' && e.runId === runId) || (e.type === 'work.changed' && e.kind === 'run' && e.runId === runId)

/** A run's activity timeline, live while it runs. */
export function useRunEvents(key: string, runId: string | null): ApiResource<RunEventsPage | null> {
  return useApiResource(() => (runId ? listRunEvents(key, runId) : Promise.resolve(null)), [key, runId], runActivity(runId))
}

const storyTasksChanged = (key: string, number: number) => (e: PlatformEvent) =>
  (e.type === 'story.changed' && e.projectKey === key && e.storyNumber === number) ||
  (e.type === 'work.changed' && e.kind === 'run' && e.projectKey === key && e.storyNumber === number)

/** A story's tasks, each with its latest run. */
export function useStoryTasks(key: string, number: number | null): ApiResource<StoryTask[]> {
  return useApiResource(() => (number ? listTasks(key, number) : Promise.resolve([])), [key, number], number ? storyTasksChanged(key, number) : undefined)
}
