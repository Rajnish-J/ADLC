// Chat API calls (everything except the streamed turn, which useChat's transport posts to /api/v1/chat).

import { z } from 'zod'
import {
  ChatAgentSummarySchema,
  ChatConfigSchema,
  ChatDraftSchema,
  ChatThreadDetailSchema,
  ChatThreadSummarySchema,
  ChatToolInfoSchema,
  type ChatAgentSummary,
  type ChatConfig,
  type ChatDraft,
  type ChatThreadDetail,
  type ChatThreadSummary,
  type ChatToolInfo,
  type ChatToolMode,
  type CreateChatThreadInput,
  type UpdateChatThreadInput,
} from '@sdlc/contracts'
import { apiCommand, apiRequest } from './http'

/** Where the streamed turn is posted (through the same-origin proxy). */
export const CHAT_STREAM_PATH = '/api/v1/chat'

export function getChatConfig(): Promise<ChatConfig> {
  return apiRequest('/chat/config', ChatConfigSchema)
}

export function listChatAgents(): Promise<ChatAgentSummary[]> {
  return apiRequest('/chat/agents', z.array(ChatAgentSummarySchema))
}

export function listChatTools(agent: string, projectKey: string | null, mode: ChatToolMode): Promise<ChatToolInfo[]> {
  const q = new URLSearchParams({ agent, mode })
  if (projectKey) q.set('project', projectKey)
  return apiRequest(`/chat/tools?${q}`, z.array(ChatToolInfoSchema))
}

export function listThreads(): Promise<ChatThreadSummary[]> {
  return apiRequest('/chat/threads', z.array(ChatThreadSummarySchema))
}

export function createThread(input: CreateChatThreadInput): Promise<ChatThreadSummary> {
  return apiRequest('/chat/threads', ChatThreadSummarySchema, { method: 'POST', body: input })
}

export function getThread(id: string): Promise<ChatThreadDetail> {
  return apiRequest(`/chat/threads/${id}`, ChatThreadDetailSchema)
}

export function updateThread(id: string, input: UpdateChatThreadInput): Promise<ChatThreadSummary> {
  return apiRequest(`/chat/threads/${id}`, ChatThreadSummarySchema, { method: 'PATCH', body: input })
}

export function deleteThread(id: string): Promise<void> {
  return apiCommand(`/chat/threads/${id}`, { method: 'DELETE' })
}

export function listThreadDrafts(threadId: string): Promise<ChatDraft[]> {
  return apiRequest(`/chat/threads/${threadId}/drafts`, z.array(ChatDraftSchema))
}

export function saveDraft(id: string, version: number, data: unknown): Promise<ChatDraft> {
  return apiRequest(`/chat/drafts/${id}`, ChatDraftSchema, { method: 'PATCH', body: { version, data } })
}

export function submitDraft(id: string): Promise<ChatDraft> {
  return apiRequest(`/chat/drafts/${id}/submit`, ChatDraftSchema, { method: 'POST' })
}

export function discardDraft(id: string): Promise<ChatDraft> {
  return apiRequest(`/chat/drafts/${id}/discard`, ChatDraftSchema, { method: 'POST' })
}
