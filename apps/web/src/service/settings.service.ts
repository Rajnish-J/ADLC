// Settings: your preferences and connected VS Code windows, project settings and archiving, and (org admins)
// people, archived projects and the system status.

import { z } from 'zod'
import {
  AccessTokenSchema,
  ArchivedProjectSchema,
  CreatedAccessTokenSchema,
  MySettingsSchema,
  OrgPeopleSchema,
  ProjectDetailSchema,
  SystemStatusSchema,
  type AccessToken,
  type ArchivedProject,
  type CreateAccessTokenInput,
  type CreatedAccessToken,
  type MySettings,
  type OrgPeople,
  type OrgRole,
  type ProjectDetail,
  type SystemStatus,
  type UpdatePreferencesInput,
  type UpdateProjectInput,
} from '@sdlc/contracts'
import { apiCommand, apiRequest } from './http'

const projectPath = (key: string): string => `/projects/${encodeURIComponent(key)}`

// ─── You ─────────────────────────────────────────────────────────────────────────────────────────

export function getMySettings(): Promise<MySettings> {
  return apiRequest('/me/settings', MySettingsSchema)
}

export function updatePreferences(input: UpdatePreferencesInput): Promise<MySettings> {
  return apiRequest('/me/preferences', MySettingsSchema, { method: 'PUT', body: input })
}

/** Forget a VS Code window (it reappears if it is still running and connected). */
export function removeClient(clientId: string): Promise<void> {
  return apiCommand(`/me/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' })
}

// ─── Access tokens (how VS Code signs in) ─────────────────────────────────────────────────────────

export function listAccessTokens(): Promise<AccessToken[]> {
  return apiRequest('/me/access-tokens', z.array(AccessTokenSchema))
}

/** The response carries the token itself — the only time it is ever shown. */
export function createAccessToken(input: CreateAccessTokenInput): Promise<CreatedAccessToken> {
  return apiRequest('/me/access-tokens', CreatedAccessTokenSchema, { method: 'POST', body: input })
}

export function revokeAccessToken(id: string): Promise<void> {
  return apiCommand(`/me/access-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ─── Projects ────────────────────────────────────────────────────────────────────────────────────

export function updateProject(key: string, input: UpdateProjectInput): Promise<ProjectDetail> {
  return apiRequest(projectPath(key), ProjectDetailSchema, { method: 'PATCH', body: input })
}

export function archiveProject(key: string): Promise<void> {
  return apiCommand(`${projectPath(key)}/archive`, { method: 'POST' })
}

// ─── Organization (org admins) ───────────────────────────────────────────────────────────────────

export function listPeople(): Promise<OrgPeople> {
  return apiRequest('/org/people', OrgPeopleSchema)
}

export function setOrgRole(userId: string, orgRole: OrgRole): Promise<OrgPeople> {
  return apiRequest(`/org/people/${userId}`, OrgPeopleSchema, { method: 'PATCH', body: { orgRole } })
}

export function listArchivedProjects(): Promise<ArchivedProject[]> {
  return apiRequest('/org/projects/archived', z.array(ArchivedProjectSchema))
}

export function restoreProject(id: string): Promise<ArchivedProject[]> {
  return apiRequest(`/org/projects/${id}/restore`, z.array(ArchivedProjectSchema), { method: 'POST' })
}

export function getSystemStatus(): Promise<SystemStatus> {
  return apiRequest('/admin/system', SystemStatusSchema)
}
