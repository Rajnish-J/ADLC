'use client'

import type { Story } from '@sdlc/contracts'
import { boardChanged } from '@/hooks/common/liveFilters'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getStory, listMyStories, listStories } from '@/service/story.service'

/** All stories of a project — the board. Refreshes on any change in the project, and when a story's run changes. */
export function useStories(key: string): ApiResource<Story[]> {
  return useApiResource(() => listStories(key), [key], boardChanged(key))
}

/** One story. Refreshes when it (or its project's membership) changes, or one of its runs does. */
export function useStory(key: string, number: number): ApiResource<Story> {
  return useApiResource(
    () => getStory(key, number),
    [key, number],
    (e) =>
      (e.type === 'story.changed' && e.projectKey === key && e.storyNumber === number) ||
      (e.type === 'work.changed' && e.kind === 'run' && e.projectKey === key && e.storyNumber === number) ||
      (e.type === 'project.changed' && e.projectKey === key),
  )
}

/** Stories assigned to me across projects. Refreshes when any story changes. */
export function useMyStories(): ApiResource<Story[]> {
  return useApiResource(listMyStories, [], (e) => e.type === 'story.changed')
}
