import { AiStatusSchema, MemoryIndexStatusSchema, type AiStatus, type MemoryIndexStatus } from '@sdlc/contracts'
import { apiRequest } from './http'

/** What the platform's AI can do: the chat models (profiler, curator) and the embedding model (semantic search). */
export function getAiStatus(): Promise<AiStatus> {
  return apiRequest('/ai/status', AiStatusSchema)
}

/** How much of the project's memory is indexed for semantic search. */
export function getMemoryIndex(key: string): Promise<MemoryIndexStatus> {
  return apiRequest(`/projects/${encodeURIComponent(key)}/memory/index`, MemoryIndexStatusSchema)
}

/** Re-embed every memory item of the project (in the background). */
export function rebuildMemoryIndex(key: string): Promise<MemoryIndexStatus> {
  return apiRequest(`/projects/${encodeURIComponent(key)}/memory/index/rebuild`, MemoryIndexStatusSchema, { method: 'POST' })
}
