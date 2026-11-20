import { z } from 'zod'
import {
  AuditEntrySchema,
  BoardsSyncResponseSchema,
  StorySchema,
  type AuditEntry,
  type BoardsSyncResponse,
  type CreateStoryInput,
  type MoveStoryInput,
  type Story,
  type StoryStatus,
  type UpdateStoryInput,
} from '@sdlc/contracts'
import { apiRequest } from './http'

const storiesPath = (key: string): string => `/projects/${encodeURIComponent(key)}/stories`
const storyPath = (key: string, number: number): string => `${storiesPath(key)}/${number}`

/** Stories assigned to the signed-in user, across every project they can see. */
export function listMyStories(): Promise<Story[]> {
  return apiRequest('/me/stories', z.array(StorySchema))
}

export function listStories(key: string): Promise<Story[]> {
  return apiRequest(storiesPath(key), z.array(StorySchema))
}

export function getStory(key: string, number: number): Promise<Story> {
  return apiRequest(storyPath(key, number), StorySchema)
}

export function createStory(key: string, input: CreateStoryInput): Promise<Story> {
  return apiRequest(storiesPath(key), StorySchema, { method: 'POST', body: input })
}

export function updateStory(key: string, number: number, input: UpdateStoryInput): Promise<Story> {
  return apiRequest(storyPath(key, number), StorySchema, { method: 'PATCH', body: input })
}

export function moveStory(key: string, number: number, to: StoryStatus): Promise<Story> {
  return apiRequest(`${storyPath(key, number)}/transition`, StorySchema, { method: 'POST', body: { to } })
}

export function pickUpStory(key: string, number: number): Promise<Story> {
  return apiRequest(`${storyPath(key, number)}/pickup`, StorySchema, { method: 'POST' })
}

export function assignStory(key: string, number: number, userId: string | null): Promise<Story> {
  return apiRequest(`${storyPath(key, number)}/assign`, StorySchema, { method: 'POST', body: { userId } })
}

/** A board drop: the story's column and, optionally, the cards it landed between. */
export function moveStoryTo(key: string, number: number, input: MoveStoryInput): Promise<Story> {
  return apiRequest(`${storyPath(key, number)}/move`, StorySchema, { method: 'POST', body: input })
}

/** The story's history, newest first; pass the last entry's id as `before` for the next page. */
export function listStoryActivity(key: string, number: number, before?: number): Promise<AuditEntry[]> {
  const query = before ? `?before=${before}` : ''
  return apiRequest(`${storyPath(key, number)}/activity${query}`, z.array(AuditEntrySchema))
}

/** Pull my assigned Azure Boards work items into every linked project I'm on (throttled server-side unless `force`). */
export function syncMyStories(force = false): Promise<BoardsSyncResponse> {
  return apiRequest(`/me/stories/sync${force ? '?force=true' : ''}`, BoardsSyncResponseSchema, { method: 'POST' })
}

/** Pull my assigned Azure Boards work items into one project (always runs). */
export function syncProjectStories(key: string): Promise<BoardsSyncResponse> {
  return apiRequest(`${storiesPath(key)}/sync`, BoardsSyncResponseSchema, { method: 'POST' })
}
