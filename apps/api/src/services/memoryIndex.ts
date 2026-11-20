// Semantic memory: every accepted or proposed memory item gets an embedding (pgvector), so runs and the Memory page
// find related knowledge by meaning as well as by keywords. The index follows memory on its own — it listens for
// `memory.changed` (every memory write publishes it) and re-embeds only items whose text changed — so no write path
// has to know about it. Off for a project when its AI setting "semantic search" is off, and everywhere when no
// embedding deployment is configured; callers then fall back to keyword search.

import { createHash } from 'node:crypto'
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import { readProjectSettings, type MemoryIndexStatus } from '@sdlc/contracts'
import { assertCan, loadProjectAccess } from '../access'
import type { EmbeddingRuntime } from '../ai/embeddings'
import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import { memoryEmbeddings } from '../db/embeddingSchema'
import { memoryItems, projects } from '../db/schema'
import type { EventBus } from '../events'
import type { Caller } from './context'

interface Logger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

const INDEXED_STATUSES = ['accepted', 'proposed'] as const
/** text-embedding-3 takes ~8k tokens; this many characters stays well inside it. */
const MAX_TEXT = 8_000

export function embeddingText(title: string, content: string): string {
  const text = `${title.trim()}\n\n${content.trim()}`
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text
}

export function contentHash(model: string, title: string, content: string): string {
  return createHash('sha256').update(`${model}\n${title}\n${content}`).digest('hex')
}

/**
 * Reciprocal-rank fusion: merge ranked id lists (keyword and semantic) into one ranking. An id ranked high in either
 * list, or present in both, comes first. Pure — unit-tested.
 */
export function fuseRankings(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

export interface SimilarQuery {
  limit: number
  /** Only items in this scope (default: project). */
  scope?: 'project' | 'story' | 'any'
  statuses?: Array<(typeof INDEXED_STATUSES)[number]>
  excludeIds?: string[]
  /** Cosine similarity below this is not "related" (0–1). */
  minScore?: number
  /** Give up on the query embedding after this long (the caller falls back to keywords). */
  timeoutMs?: number
}

export interface MemoryIndexer {
  readonly enabled: boolean
  readonly reason: string | null
  readonly model: string | null
  /** Ids of the items most similar to `text`, best first — or null when semantic search is unavailable here. */
  similar(projectId: string, text: string, query: SimilarQuery): Promise<Array<{ id: string; score: number }> | null>
  /** Whether semantic search is on for the project (setting + configured + something indexed). */
  usable(projectId: string, settings: unknown): Promise<boolean>
  status(user: AuthUser, key: string): Promise<MemoryIndexStatus>
  rebuild(caller: Caller, key: string): Promise<MemoryIndexStatus>
  /** Index one project now (tests, rebuild). */
  indexProject(projectId: string, force?: boolean): Promise<number>
  resume(): Promise<void>
  stop(): void
}

export function createMemoryIndexer(deps: { db: Db; bus: EventBus }, embeddings: EmbeddingRuntime, log: Logger, options: { debounceMs?: number } = {}): MemoryIndexer {
  const { db, bus } = deps
  const model = embeddings.model ?? ''
  const debounceMs = options.debounceMs ?? 5_000
  const chains = new Map<string, Promise<unknown>>()
  const timers = new Map<string, NodeJS.Timeout>()
  const running = new Set<string>()
  // Query embeddings repeat (the same story is asked for on every step): keep the last few hundred.
  const queryCache = new Map<string, number[]>()

  async function settingsOf(projectId: string) {
    const [p] = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1)
    return p ? readProjectSettings(p.settings).ai : null
  }

  async function indexProject(projectId: string, force = false): Promise<number> {
    if (!embeddings.enabled) return 0
    const ai = await settingsOf(projectId)
    if (!ai || (!ai.semanticSearch && !force)) return 0
    running.add(projectId)
    try {
      const items = await db
        .select({ id: memoryItems.id, title: memoryItems.title, content: memoryItems.content })
        .from(memoryItems)
        .where(and(eq(memoryItems.projectId, projectId), inArray(memoryItems.status, [...INDEXED_STATUSES]), ne(memoryItems.source, 'profile')))
      const ids = items.map((i) => i.id)
      // Vectors of items that were rejected, archived or deleted go.
      await db
        .delete(memoryEmbeddings)
        .where(and(eq(memoryEmbeddings.projectId, projectId), ...(ids.length ? [notInArray(memoryEmbeddings.memoryItemId, ids)] : [])))
      const existing = new Map(
        (await db.select({ id: memoryEmbeddings.memoryItemId, hash: memoryEmbeddings.contentHash }).from(memoryEmbeddings).where(eq(memoryEmbeddings.projectId, projectId))).map(
          (r) => [r.id, r.hash],
        ),
      )
      const stale = items.filter((i) => force || existing.get(i.id) !== contentHash(model, i.title, i.content))
      if (!stale.length) return 0
      const vectors = await embeddings.embedMany(stale.map((i) => embeddingText(i.title, i.content)))
      for (let i = 0; i < stale.length; i += 100) {
        const values = stale.slice(i, i + 100).map((item, j) => ({
          memoryItemId: item.id,
          projectId,
          model,
          contentHash: contentHash(model, item.title, item.content),
          embedding: vectors[i + j],
          updatedAt: new Date(),
        }))
        await db
          .insert(memoryEmbeddings)
          .values(values)
          .onConflictDoUpdate({
            target: memoryEmbeddings.memoryItemId,
            set: { model: sql`excluded.model`, contentHash: sql`excluded.content_hash`, embedding: sql`excluded.embedding`, updatedAt: sql`excluded.updated_at` },
          })
      }
      log.info({ projectId, embedded: stale.length }, 'Memory index updated')
      return stale.length
    } finally {
      running.delete(projectId)
    }
  }

  function enqueue(projectId: string, force = false): Promise<number> {
    const prev = chains.get(projectId) ?? Promise.resolve()
    const next = prev
      .then(() => indexProject(projectId, force))
      .catch((err) => {
        log.warn({ err, projectId }, 'Could not update the memory index')
        return 0
      })
    chains.set(projectId, next)
    void next.finally(() => {
      if (chains.get(projectId) === next) chains.delete(projectId)
    })
    return next
  }

  function schedule(projectId: string): void {
    const t = timers.get(projectId)
    if (t) clearTimeout(t)
    const timer = setTimeout(() => {
      timers.delete(projectId)
      void enqueue(projectId)
    }, debounceMs)
    timer.unref?.()
    timers.set(projectId, timer)
  }

  const unsubscribe = embeddings.enabled
    ? bus.subscribe((e) => {
        // Memory writes, and settings changes (semantic search switched on) re-check the project's index.
        if (e.type !== 'memory.changed' && e.type !== 'project.changed') return
        void db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.key, e.projectKey))
          .then((rows) => rows.forEach((r) => schedule(r.id)))
          .catch((err) => log.warn({ err }, 'Memory index: could not resolve the project'))
      })
    : () => undefined

  async function queryVector(text: string, timeoutMs: number): Promise<number[]> {
    const key = createHash('sha256').update(text).digest('hex')
    const hit = queryCache.get(key)
    if (hit) return hit
    const v = await embeddings.embed(text, timeoutMs)
    queryCache.set(key, v)
    if (queryCache.size > 300) queryCache.delete(queryCache.keys().next().value as string)
    return v
  }

  async function usable(projectId: string, settings: unknown): Promise<boolean> {
    if (!embeddings.enabled || !readProjectSettings(settings).ai.semanticSearch) return false
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(memoryEmbeddings).where(eq(memoryEmbeddings.projectId, projectId))
    return (r?.n ?? 0) > 0
  }

  async function similar(projectId: string, text: string, q: SimilarQuery): Promise<Array<{ id: string; score: number }> | null> {
    if (!embeddings.enabled || !text.trim()) return null
    try {
      const vector = await queryVector(text.slice(0, MAX_TEXT), q.timeoutMs ?? 3_000)
      const literal = `[${vector.join(',')}]`
      const distance = sql<number>`${memoryEmbeddings.embedding} <=> ${literal}::vector`
      const filters = [eq(memoryEmbeddings.projectId, projectId), inArray(memoryItems.status, q.statuses ?? ['accepted'])]
      const scope = q.scope ?? 'project'
      if (scope !== 'any') filters.push(eq(memoryItems.scope, scope))
      if (q.excludeIds?.length) filters.push(notInArray(memoryItems.id, q.excludeIds))
      const rows = await db
        .select({ id: memoryItems.id, distance })
        .from(memoryEmbeddings)
        .innerJoin(memoryItems, eq(memoryItems.id, memoryEmbeddings.memoryItemId))
        .where(and(...filters))
        .orderBy(distance)
        .limit(q.limit)
      return rows.map((r) => ({ id: r.id, score: 1 - Number(r.distance) })).filter((r) => r.score >= (q.minScore ?? 0))
    } catch (err) {
      log.warn({ err, projectId }, 'Semantic memory search failed; using keyword search')
      return null
    }
  }

  async function status(user: AuthUser, key: string): Promise<MemoryIndexStatus> {
    const access = await loadProjectAccess(db, user, key)
    const projectId = access.project.id
    const items = await db
      .select({ id: memoryItems.id, title: memoryItems.title, content: memoryItems.content })
      .from(memoryItems)
      .where(and(eq(memoryItems.projectId, projectId), inArray(memoryItems.status, [...INDEXED_STATUSES]), ne(memoryItems.source, 'profile')))
    const hashes = new Map(
      (await db.select({ id: memoryEmbeddings.memoryItemId, hash: memoryEmbeddings.contentHash }).from(memoryEmbeddings).where(eq(memoryEmbeddings.projectId, projectId))).map(
        (r) => [r.id, r.hash],
      ),
    )
    const indexed = items.filter((i) => hashes.get(i.id) === contentHash(model, i.title, i.content)).length
    return {
      enabled: embeddings.enabled,
      semanticSearch: readProjectSettings(access.project.settings).ai.semanticSearch,
      reason: embeddings.reason,
      model: embeddings.model,
      total: items.length,
      indexed,
      stale: items.length - indexed,
      indexing: running.has(projectId) || timers.has(projectId),
    }
  }

  async function rebuild(caller: Caller, key: string): Promise<MemoryIndexStatus> {
    const access = await loadProjectAccess(db, caller.user, key)
    assertCan(access, 'memory.curate')
    if (embeddings.enabled) void enqueue(access.project.id, true)
    return { ...(await status(caller.user, key)), indexing: embeddings.enabled }
  }

  async function resume(): Promise<void> {
    if (!embeddings.enabled) return
    const rows = await db.select({ id: projects.id }).from(projects)
    for (const r of rows) void enqueue(r.id)
  }

  function stop(): void {
    unsubscribe()
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }

  return { enabled: embeddings.enabled, reason: embeddings.reason, model: embeddings.model, similar, usable, status, rebuild, indexProject, resume, stop }
}
