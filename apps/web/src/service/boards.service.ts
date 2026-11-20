// Azure Boards: a project's link to an Azure DevOps project (owners and org admins change it) and the signed-in
// user's Azure DevOps identity override (what their assigned work items are matched against).

import {
  AdoTokenResponseSchema,
  BoardsAreasSchema,
  BoardsPruneResultSchema,
  BoardsIdentitySchema,
  MyWorkItemsResponseSchema,
  ProjectBoardsSchema,
  type AdoTokenResponse,
  type BoardsPruneResult,
  type BoardsIdentity,
  type MyWorkItemsResponse,
  type ProjectBoards,
  type SetAdoTokenInput,
  type UpdateProjectBoardsInput,
} from '@sdlc/contracts'
import { apiCommand, apiRequest } from './http'

const boardsPath = (key: string): string => `/projects/${encodeURIComponent(key)}/boards`

export function getProjectBoards(key: string): Promise<ProjectBoards> {
  return apiRequest(boardsPath(key), ProjectBoardsSchema)
}

export function updateProjectBoards(key: string, input: UpdateProjectBoardsInput): Promise<ProjectBoards> {
  return apiRequest(boardsPath(key), ProjectBoardsSchema, { method: 'PUT', body: input })
}

export function getBoardsIdentity(): Promise<BoardsIdentity> {
  return apiRequest('/me/boards-identity', BoardsIdentitySchema)
}

/** Set (or, with null, clear) the email / UPN my Azure DevOps work items are matched against. */
export function setBoardsIdentity(identity: string | null): Promise<BoardsIdentity> {
  return apiRequest('/me/boards-identity', BoardsIdentitySchema, { method: 'PUT', body: { identity } })
}

// ─── My work items (my own Azure DevOps token, read live) ──────────────────────────────────────────

/** My Azure DevOps access (null when none) and the organisation's Azure Git connections I could use. */
export function getAdoToken(): Promise<AdoTokenResponse> {
  return apiRequest('/me/ado-token', AdoTokenResponseSchema)
}

/** Check and save my Azure DevOps token (a 422 explains a rejected token). */
export function setAdoToken(input: SetAdoTokenInput): Promise<AdoTokenResponse> {
  return apiRequest('/me/ado-token', AdoTokenResponseSchema, { method: 'PUT', body: input })
}

/** Use an organisation Azure Git connection whose token is mine (403 when it's someone else's). */
export function linkAdoConnection(connectionId: string): Promise<AdoTokenResponse> {
  return apiRequest('/me/ado-token/connection', AdoTokenResponseSchema, { method: 'PUT', body: { connectionId } })
}

export function deleteAdoToken(): Promise<void> {
  return apiCommand('/me/ado-token', { method: 'DELETE' })
}

/** Every work item assigned to me in my Azure DevOps organization (409 `ado_token_missing` without a token). */
export function getMyWorkItems(): Promise<MyWorkItemsResponse> {
  return apiRequest('/me/work-items', MyWorkItemsResponseSchema)
}

/** An Azure DevOps project's area paths (root first), to pick the area a platform project syncs from. */
export async function getBoardsAreas(key: string, organization: string, project: string): Promise<string[]> {
  const q = new URLSearchParams({ organization, project })
  return (await apiRequest(`${boardsPath(key)}/areas?${q}`, BoardsAreasSchema)).areas
}

/** Stories synced from work items outside the project's area: listed (`dryRun`) or deleted. */
export function pruneProjectBoards(key: string, dryRun: boolean): Promise<BoardsPruneResult> {
  return apiRequest(`${boardsPath(key)}/prune?dryRun=${dryRun}`, BoardsPruneResultSchema, { method: 'POST' })
}
