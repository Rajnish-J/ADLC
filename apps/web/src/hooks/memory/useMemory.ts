'use client'

import type { MemoryItem } from '@sdlc/contracts'
import { projectMemoryChanged, storyMemoryChanged } from '@/hooks/common/liveFilters'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { listProjectMemory, listStoryMemory, type MemoryQuery } from '@/service/memory.service'

/** One story's memory. Refreshes when it (or the project's memory) changes. */
export function useStoryMemory(key: string, number: number): ApiResource<MemoryItem[]> {
  return useApiResource(() => listStoryMemory(key, number), [key, number], storyMemoryChanged(key, number))
}

/** Project memory (or, with `scope: 'story'`, all story memory) — refreshes on any memory change in the project. */
export function useProjectMemory(key: string, query: MemoryQuery = {}): ApiResource<MemoryItem[]> {
  const { scope, status, kind, q } = query
  return useApiResource(() => listProjectMemory(key, { scope, status, kind, q }), [key, scope, status, kind, q], projectMemoryChanged(key))
}
