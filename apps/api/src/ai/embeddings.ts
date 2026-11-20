// Text embeddings for semantic memory search: an Azure OpenAI embedding deployment (text-embedding-3-*), shortened
// to the vector size the database stores. Off — with the reason — when no deployment is configured; callers then
// fall back to keyword search.

import { createAzure } from '@ai-sdk/azure'
import { embedMany } from 'ai'
import { resolveAzureBaseUrl } from '../chat/llm'
import type { Config } from '../config'

/** The vector column's size (memory_embeddings.embedding). */
export const EMBEDDING_DIMENSIONS = 1536

export interface EmbeddingRuntime {
  enabled: boolean
  reason: string | null
  /** Deployment name, stored with each vector so a model change re-embeds. */
  model: string | null
  dimensions: number
  embedMany(texts: string[], timeoutMs?: number): Promise<number[][]>
  embed(text: string, timeoutMs?: number): Promise<number[]>
}

const BATCH = 64

export function createEmbeddingRuntime(config: Config): EmbeddingRuntime {
  const deployment = config.AZURE_EMBEDDING_DEPLOYMENT ?? null
  const apiKey = config.AZURE_EMBEDDING_API_KEY ?? config.AZURE_OPENAI_API_KEY
  const baseUrl = config.AZURE_EMBEDDING_BASE_URL ?? config.AZURE_OPENAI_BASE_URL
  let reason: string | null = null
  if (!deployment) reason = 'Semantic search is off: set AZURE_EMBEDDING_DEPLOYMENT (and its endpoint and key) for the API.'
  else if (!apiKey) reason = 'Semantic search is off: set AZURE_EMBEDDING_API_KEY for the API.'
  else if (!baseUrl && !config.AZURE_OPENAI_RESOURCE_NAME) reason = 'Semantic search is off: set AZURE_EMBEDDING_BASE_URL for the API.'
  else if (config.AZURE_EMBEDDING_DIMENSIONS !== EMBEDDING_DIMENSIONS) reason = `Semantic search is off: AZURE_EMBEDDING_DIMENSIONS must be ${EMBEDDING_DIMENSIONS} (the stored vector size).`

  const provider =
    reason === null
      ? createAzure({ apiKey, ...(baseUrl ? { baseURL: resolveAzureBaseUrl(baseUrl) } : { resourceName: config.AZURE_OPENAI_RESOURCE_NAME }) })
      : null

  async function many(texts: string[], timeoutMs = 30_000): Promise<number[][]> {
    if (!provider || !deployment) throw new Error(reason ?? 'Embeddings are not configured.')
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += BATCH) {
      const { embeddings } = await embedMany({
        model: provider.embedding(deployment),
        values: texts.slice(i, i + BATCH),
        providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
        abortSignal: AbortSignal.timeout(timeoutMs),
      })
      out.push(...embeddings)
    }
    return out
  }

  return {
    enabled: provider !== null,
    reason,
    model: deployment,
    dimensions: EMBEDDING_DIMENSIONS,
    embedMany: many,
    async embed(text, timeoutMs) {
      const [v] = await many([text], timeoutMs)
      return v
    },
  }
}
