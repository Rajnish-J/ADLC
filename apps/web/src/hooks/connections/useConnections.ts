'use client'

import type { GitConnection } from '@sdlc/contracts'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { listConnections } from '@/service/connections.service'

/** The organisation's Git connections. Refreshed when a repository changes (its usage counts may move). */
export function useConnections(): ApiResource<GitConnection[]> {
  return useApiResource(() => listConnections(), [], (e) => e.type === 'repo.changed' || (e.type === 'project.changed' && e.action === 'repository'))
}
