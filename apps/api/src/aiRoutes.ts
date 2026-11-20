// What the platform's AI can do (/api/v1/ai/status), and a project's semantic memory index (status, rebuild).

import type { FastifyInstance } from 'fastify'
import type { AiStatus, MemoryIndexStatus } from '@sdlc/contracts'
import type { ChatRuntime } from './chat/llm'
import { parse } from './http'
import { caller, KeyParams } from './routeKit'
import type { ServiceDeps } from './services/context'

const NO_INDEX: Omit<MemoryIndexStatus, 'semanticSearch'> = {
  enabled: false,
  reason: 'Semantic search is not available on this server.',
  model: null,
  total: 0,
  indexed: 0,
  stale: 0,
  indexing: false,
}

export function registerAiRoutes(app: FastifyInstance, deps: ServiceDeps, chat: ChatRuntime): void {
  app.get('/api/v1/ai/status', async (): Promise<AiStatus> => {
    const index = deps.memoryIndex
    return {
      chat: { enabled: chat.config.enabled, reason: chat.config.reason, models: chat.config.models, defaultModel: chat.config.defaultModel },
      embeddings: { enabled: index?.enabled ?? false, reason: index ? index.reason : NO_INDEX.reason, model: index?.model ?? null, dimensions: 1536 },
    }
  })

  app.get('/api/v1/projects/:key/memory/index', async (req): Promise<MemoryIndexStatus> => {
    const { key } = parse(KeyParams, req.params)
    if (!deps.memoryIndex) return { ...NO_INDEX, semanticSearch: false }
    return deps.memoryIndex.status(req.user, key)
  })

  /** Re-embed every memory item of the project (curators). Runs in the background. */
  app.post('/api/v1/projects/:key/memory/index/rebuild', async (req, reply): Promise<MemoryIndexStatus> => {
    const { key } = parse(KeyParams, req.params)
    if (!deps.memoryIndex) return { ...NO_INDEX, semanticSearch: false }
    reply.code(202)
    return deps.memoryIndex.rebuild(caller(req), key)
  })
}
