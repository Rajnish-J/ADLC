// What the platform's AI can do right now (GET /ai/status), and how far a project's memory is indexed for semantic
// search (GET /projects/:key/memory/index). Shown in Project settings → Memory → AI & context.

import { z } from 'zod'
import { ChatModelSchema } from './chat'

export const AiStatusSchema = z.object({
  chat: z.object({
    enabled: z.boolean(),
    reason: z.string().nullable(),
    models: z.array(ChatModelSchema),
    defaultModel: z.string().nullable(),
  }),
  embeddings: z.object({
    enabled: z.boolean(),
    reason: z.string().nullable(),
    model: z.string().nullable(),
    dimensions: z.number().int(),
  }),
})
export type AiStatus = z.infer<typeof AiStatusSchema>

export const MemoryIndexStatusSchema = z.object({
  /** Embeddings are configured on the server. */
  enabled: z.boolean(),
  /** The project's setting (semantic search on/off). */
  semanticSearch: z.boolean(),
  reason: z.string().nullable(),
  model: z.string().nullable(),
  /** Memory items that should have a vector (accepted and proposed). */
  total: z.number().int(),
  /** Items with a current vector. */
  indexed: z.number().int(),
  /** Items whose vector is missing or out of date. */
  stale: z.number().int(),
  indexing: z.boolean(),
})
export type MemoryIndexStatus = z.infer<typeof MemoryIndexStatusSchema>
