import { z } from 'zod'
import {
  MemoryItemSchema,
  type CreateMemoryInput,
  type DecideMemoryInput,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
  type UpdateMemoryInput,
} from '@sdlc/contracts'
import { apiRequest } from './http'

const projectMemoryPath = (key: string): string => `/projects/${encodeURIComponent(key)}/memory`
const storyMemoryPath = (key: string, number: number): string => `/projects/${encodeURIComponent(key)}/stories/${number}/memory`

export interface MemoryQuery {
  scope?: MemoryScope
  status?: MemoryStatus
  kind?: MemoryKind
  q?: string
}

/** Project memory (default), or with `scope: 'story'` every story's memory in the project. */
export function listProjectMemory(key: string, query: MemoryQuery = {}): Promise<MemoryItem[]> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, String(v))
  const qs = params.toString()
  return apiRequest(`${projectMemoryPath(key)}${qs ? `?${qs}` : ''}`, z.array(MemoryItemSchema))
}

export function listStoryMemory(key: string, number: number): Promise<MemoryItem[]> {
  return apiRequest(storyMemoryPath(key, number), z.array(MemoryItemSchema))
}

export function addStoryMemory(key: string, number: number, input: CreateMemoryInput): Promise<MemoryItem> {
  return apiRequest(storyMemoryPath(key, number), MemoryItemSchema, { method: 'POST', body: input })
}

export function addProjectMemory(key: string, input: CreateMemoryInput): Promise<MemoryItem> {
  return apiRequest(projectMemoryPath(key), MemoryItemSchema, { method: 'POST', body: input })
}

export function updateMemory(key: string, id: string, input: UpdateMemoryInput): Promise<MemoryItem> {
  return apiRequest(`${projectMemoryPath(key)}/${id}`, MemoryItemSchema, { method: 'PATCH', body: input })
}

export function promoteMemory(key: string, id: string): Promise<MemoryItem> {
  return apiRequest(`${projectMemoryPath(key)}/${id}/promote`, MemoryItemSchema, { method: 'POST' })
}

export function decideMemory(key: string, id: string, input: DecideMemoryInput): Promise<MemoryItem> {
  return apiRequest(`${projectMemoryPath(key)}/${id}/decide`, MemoryItemSchema, { method: 'POST', body: input })
}

export function archiveMemory(key: string, id: string): Promise<MemoryItem> {
  return apiRequest(`${projectMemoryPath(key)}/${id}/archive`, MemoryItemSchema, { method: 'POST' })
}
