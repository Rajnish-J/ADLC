import { z } from 'zod'
import {
  ProfileVersionSummarySchema,
  ProjectProfileSchema,
  ProjectProfileStateSchema,
  type DecideProfileInput,
  type GenerateProfileInput,
  type ProfileVersionSummary,
  type ProjectProfile,
  type ProjectProfileState,
  type UpdateProfileInput,
} from '@sdlc/contracts'
import { apiRequest } from './http'

const profilePath = (key: string): string => `/projects/${encodeURIComponent(key)}/profile`

/** The accepted profile, the update waiting for review (or a generation in progress), and what the caller may do. */
export function getProjectProfile(key: string): Promise<ProjectProfileState> {
  return apiRequest(profilePath(key), ProjectProfileStateSchema)
}

export function listProfileVersions(key: string): Promise<ProfileVersionSummary[]> {
  return apiRequest(`${profilePath(key)}/versions`, z.array(ProfileVersionSummarySchema))
}

export function getProfileVersion(key: string, id: string): Promise<ProjectProfile> {
  return apiRequest(`${profilePath(key)}/versions/${id}`, ProjectProfileSchema)
}

/** Start writing the profile from a branch (it is written in the background; follow `profile.changed`). */
export function generateProjectProfile(key: string, input: GenerateProfileInput): Promise<ProjectProfile> {
  return apiRequest(`${profilePath(key)}/generate`, ProjectProfileSchema, { method: 'POST', body: input })
}

export function decideProjectProfile(key: string, id: string, input: DecideProfileInput): Promise<ProjectProfile> {
  return apiRequest(`${profilePath(key)}/versions/${id}/decide`, ProjectProfileSchema, { method: 'POST', body: input })
}

export function updateProjectProfile(key: string, id: string, input: UpdateProfileInput): Promise<ProjectProfile> {
  return apiRequest(`${profilePath(key)}/versions/${id}`, ProjectProfileSchema, { method: 'PATCH', body: input })
}

/** Same-origin download link for the accepted profile (or one version) as Markdown. */
export function profileDownloadUrl(key: string, id?: string): string {
  return `/api/v1${profilePath(key)}/download${id ? `?id=${id}` : ''}`
}
