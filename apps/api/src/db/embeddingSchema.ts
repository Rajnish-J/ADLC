// Semantic memory (migration 0022): one embedding per memory item (pgvector, cosine HNSW index), and the cache of
// AI-curated run context. Kept in its own file (listed in drizzle.config.ts) — the tables only reference core ones.

import { index, jsonb, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core'
import { memoryItems, projects } from './schema'

export const memoryEmbeddings = pgTable(
  'memory_embeddings',
  {
    memoryItemId: uuid('memory_item_id')
      .primaryKey()
      .references(() => memoryItems.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The deployment that wrote the vector; another model means it is stale. */
    model: text('model').notNull(),
    /** sha256 of model + title + content: the vector is stale when it differs. */
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_embeddings_project_idx').on(t.projectId), index('memory_embeddings_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops'))],
)

/** A curated memory brief, keyed by the hash of everything it was written from (task, candidates, settings). */
export const memoryContextCache = pgTable(
  'memory_context_cache',
  {
    keyHash: text('key_hash').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    markdown: text('markdown').notNull(),
    itemIds: jsonb('item_ids').$type<string[]>().notNull().default([]),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_context_cache_created_idx').on(t.createdAt)],
)
