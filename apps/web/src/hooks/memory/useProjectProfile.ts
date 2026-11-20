'use client'

import type { ProfileVersionSummary, ProjectProfile, ProjectProfileState } from '@sdlc/contracts'
import { profileChanged } from '@/hooks/common/liveFilters'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getProfileVersion, getProjectProfile, listProfileVersions } from '@/service/profile.service'

/** The project profile (accepted + pending). Refreshes live while it is generated, proposed or decided. */
export function useProjectProfile(key: string): ApiResource<ProjectProfileState> {
  return useApiResource(() => getProjectProfile(key), [key], profileChanged(key))
}

/** Every version of the profile; `enabled` false skips the call (sheet closed). */
export function useProfileVersions(key: string, enabled: boolean): ApiResource<ProfileVersionSummary[]> {
  return useApiResource(() => (enabled ? listProfileVersions(key) : Promise.resolve([])), [key, enabled], profileChanged(key))
}

/** One version (with its content), or null. */
export function useProfileVersion(key: string, id: string | null): ApiResource<ProjectProfile | null> {
  return useApiResource(() => (id ? getProfileVersion(key, id) : Promise.resolve(null)), [key, id], profileChanged(key))
}
