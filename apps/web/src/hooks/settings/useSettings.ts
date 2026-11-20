'use client'

// Data hooks for the Settings page. Personal settings refresh on the user-targeted preferences / client events.

import type { AccessToken, ArchivedProject, MySettings, OrgPeople, SystemStatus } from '@sdlc/contracts'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { mySettingsChanged } from '@/hooks/common/liveFilters'
import { getMySettings, getSystemStatus, listAccessTokens, listArchivedProjects, listPeople } from '@/service/settings.service'

export function useMySettings(): ApiResource<MySettings> {
  return useApiResource(() => getMySettings(), [], mySettingsChanged)
}

/** Your personal access tokens (Settings → VS Code). */
export function useAccessTokens(): ApiResource<AccessToken[]> {
  return useApiResource(() => listAccessTokens(), [])
}

export function usePeople(enabled: boolean): ApiResource<OrgPeople | null> {
  return useApiResource(() => (enabled ? listPeople() : Promise.resolve(null)), [enabled], (e) => e.type === 'project.changed')
}

export function useArchivedProjects(enabled: boolean): ApiResource<ArchivedProject[]> {
  return useApiResource(() => (enabled ? listArchivedProjects() : Promise.resolve([])), [enabled], (e) => e.type === 'project.changed')
}

export function useSystemStatus(enabled: boolean): ApiResource<SystemStatus | null> {
  return useApiResource(() => (enabled ? getSystemStatus() : Promise.resolve(null)), [enabled], (e) => e.type === 'repo.changed')
}
