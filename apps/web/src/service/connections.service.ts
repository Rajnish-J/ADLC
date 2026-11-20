// Git connections: the organisation's GitHub / Azure Repos access tokens (org admins). Repositories use them
// automatically when they are cloned, synced or committed to.

import { z } from 'zod'
import {
  AccessibleReposSchema,
  GitConnectionSchema,
  type AccessibleRepos,
  GitConnectionTestResultSchema,
  type CreateGitConnectionInput,
  type GitConnection,
  type GitConnectionProvider,
  type GitConnectionTestResult,
  type UpdateGitConnectionInput,
} from '@sdlc/contracts'
import { apiCommand, apiRequest } from './http'

export function listConnections(): Promise<GitConnection[]> {
  return apiRequest('/git-connections', z.array(GitConnectionSchema))
}

/** Repositories a connection's token can reach — to import one as a project. */
export function listConnectionRepos(id: string, q?: string): Promise<AccessibleRepos> {
  const query = q ? `?q=${encodeURIComponent(q)}` : ''
  return apiRequest(`/git-connections/${id}/repositories${query}`, AccessibleReposSchema)
}

/** Check a token with the provider without saving it. */
export function testToken(input: { provider: GitConnectionProvider; owner?: string; token: string }): Promise<GitConnectionTestResult> {
  return apiRequest('/git-connections/test', GitConnectionTestResultSchema, { method: 'POST', body: input })
}

export function createConnection(input: CreateGitConnectionInput): Promise<GitConnection> {
  return apiRequest('/git-connections', GitConnectionSchema, { method: 'POST', body: input })
}

export function updateConnection(id: string, input: UpdateGitConnectionInput): Promise<GitConnection> {
  return apiRequest(`/git-connections/${id}`, GitConnectionSchema, { method: 'PATCH', body: input })
}

export function deleteConnection(id: string): Promise<void> {
  return apiCommand(`/git-connections/${id}`, { method: 'DELETE' })
}
