'use client'

// The project in the URL (/projects/[key]/…), loaded once for the whole shell: the sidebar, the breadcrumbs and
// the project pages all read it from here, and it refreshes live when the project changes.

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useParams } from 'next/navigation'
import type { ProjectDetail } from '@sdlc/contracts'
import { storiesOrProjectChanged } from '@/hooks/common/liveFilters'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getProject } from '@/service/project.service'
import { recordProjectVisit } from '@/utils/recentProjects'

interface CurrentProject extends ApiResource<ProjectDetail | null> {
  /** The key in the URL (upper-cased), if the route is inside a project. */
  key: string | undefined
}

const CurrentProjectContext = createContext<CurrentProject | null>(null)

export function CurrentProjectProvider({ children }: { children: ReactNode }) {
  const params = useParams<{ key?: string | string[] }>()
  const key = typeof params?.key === 'string' ? params.key.toUpperCase() : undefined
  const resource = useApiResource(
    () => (key ? getProject(key) : Promise.resolve(null)),
    [key],
    storiesOrProjectChanged(key),
  )
  // While switching projects the previous project's data is still loaded — never hand it out for the new key.
  const data = resource.data && resource.data.key === key ? resource.data : null
  const visited = data?.key
  useEffect(() => {
    if (visited) recordProjectVisit(visited)
  }, [visited])
  return <CurrentProjectContext.Provider value={{ ...resource, data, key }}>{children}</CurrentProjectContext.Provider>
}

export function useCurrentProject(): CurrentProject {
  const value = useContext(CurrentProjectContext)
  if (!value) throw new Error('useCurrentProject must be used inside CurrentProjectProvider')
  return value
}
