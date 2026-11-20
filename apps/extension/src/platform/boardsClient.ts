// Azure Boards sync calls on the SDLC platform API: sync my assigned work items into stories (every linked project,
// or one). Kept beside PlatformClient (same base URL and caller headers) so the Stories view can trigger a sync.

import { BoardsSyncResponseSchema, type BoardsSyncResponse } from '@sdlc/contracts'
import { PlatformError, type PlatformClient } from './platformClient'

async function post(client: PlatformClient, path: string): Promise<BoardsSyncResponse> {
  let res: Response
  try {
    res = await fetch(`${client.apiUrl}/api/v1${path}`, { method: 'POST', headers: client.headers() })
  } catch (err) {
    throw new PlatformError(`Cannot reach the SDLC platform API at ${client.apiUrl}${err instanceof Error ? ` (${err.message})` : ''}.`)
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const message = json && typeof json === 'object' && 'message' in json ? String((json as { message: unknown }).message) : `Request failed (${res.status}).`
    throw new PlatformError(message, res.status)
  }
  const parsed = BoardsSyncResponseSchema.safeParse(json)
  if (!parsed.success) throw new PlatformError('Unexpected response from the SDLC platform API.', res.status)
  return parsed.data
}

/** Sync my assigned Azure Boards work items into every linked project I belong to (throttled server-side unless forced). */
export function syncMyStories(client: PlatformClient, force = false): Promise<BoardsSyncResponse> {
  return post(client, `/me/stories/sync${force ? '?force=true' : ''}`)
}

/** Sync my assigned work items into one project. */
export function syncProjectStories(client: PlatformClient, projectKey: string): Promise<BoardsSyncResponse> {
  return post(client, `/projects/${encodeURIComponent(projectKey)}/stories/sync`)
}
