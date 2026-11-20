// Unit tests for the AI side of memory: hybrid ranking, the memory the profiler reads, the run-context curator
// (prompt, cache key, assembly, fallback) and the per-project AI settings. Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_AI_SETTINGS, mergeProjectSettings, readProjectSettings, UpdateProjectInputSchema } from '@sdlc/contracts'
import type { ChatRuntime } from '../chat/llm'
import type { Db } from '../db/client'
import { assembleCurated, createContextCurator, curatorCacheKey, curatorPrompt, type CurateInput, type CuratorCandidate } from './contextCurator'
import { contentHash, embeddingText, fuseRankings } from './memoryIndex'
import { renderMemoryForProfile } from './profileContent'

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('hybrid ranking', () => {
  it('puts items found by both searches first, then the best of each', () => {
    const order = fuseRankings([
      ['a', 'b', 'c'],
      ['c', 'd', 'a'],
    ])
    assert.deepEqual(order.slice(0, 2).sort(), ['a', 'c'])
    assert.deepEqual(new Set(order), new Set(['a', 'b', 'c', 'd']))
  })

  it('a single list keeps its order', () => {
    assert.deepEqual(fuseRankings([['x', 'y', 'z']]), ['x', 'y', 'z'])
  })

  it('embedding text and hash change with the content and the model', () => {
    assert.equal(embeddingText('T', 'body'), 'T\n\nbody')
    assert.equal(embeddingText('T', 'x'.repeat(20_000)).length, 8_000)
    assert.notEqual(contentHash('m', 'T', 'a'), contentHash('m', 'T', 'b'))
    assert.notEqual(contentHash('m1', 'T', 'a'), contentHash('m2', 'T', 'a'))
  })
})

describe('memory the profiler reads', () => {
  const at = (d: number) => new Date(2026, 10, d).toISOString()
  const items = [
    { kind: 'summary', title: 'Delivered cart', content: 'Cart shipped.', pinned: false, updatedAt: at(10) },
    { kind: 'learning', title: 'Flaky e2e', content: 'Retry login.', pinned: false, updatedAt: at(9) },
    { kind: 'convention', title: 'Use minor units', content: 'Amounts are cents.', pinned: false, updatedAt: at(1) },
    { kind: 'decision', title: 'Postgres only', content: 'No Mongo.', pinned: true, updatedAt: at(2) },
  ]

  it('orders pinned, then conventions, decisions, learnings, summaries', () => {
    const text = renderMemoryForProfile(items)
    const pos = (s: string) => text.indexOf(s)
    assert.ok(pos('Postgres only') < pos('Use minor units'))
    assert.ok(pos('Use minor units') < pos('Flaky e2e'))
    assert.ok(pos('Flaky e2e') < pos('Delivered cart'))
    assert.match(text, /Decision \(pinned\): Postgres only/)
  })

  it('stays within its budget and says what it left out', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'note', title: `Note ${i}`, content: 'y'.repeat(500), pinned: false, updatedAt: at(1) }))
    const text = renderMemoryForProfile(many, 3_000)
    assert.ok(text.length < 3_200)
    assert.match(text, /more item\(s\) not shown/)
    assert.equal(renderMemoryForProfile([]), '')
  })
})

describe('run-context curator', () => {
  const candidates: CuratorCandidate[] = [
    { id: ID(1), section: 'Pinned project knowledge', kind: 'Decision', title: 'Postgres only', content: 'No Mongo.', pinned: true },
    { id: ID(2), section: 'Related project knowledge', kind: 'Convention', title: 'Use minor units', content: 'Amounts are cents.', pinned: false },
    { id: ID(3), section: 'Related project knowledge', kind: 'Learning', title: 'Flaky e2e', content: 'Retry login.', pinned: false },
  ]
  const input: CurateInput = { projectId: ID(9), subject: 'SHOP-4 and its project', task: 'Add refunds', profile: '**Shop** profile', candidates, budget: 6_000, model: null }

  it('the prompt carries the task, every candidate with its id, and pinned markers', () => {
    const prompt = curatorPrompt(input, 4_000)
    assert.match(prompt, /# Task\nAdd refunds/)
    assert.match(prompt, new RegExp(`\\[${ID(1)}\\] Decision · PINNED — Postgres only`))
    assert.match(prompt, /at most 4000 characters/)
  })

  it('the cache key changes with the task, the candidates and the model', () => {
    const k = curatorCacheKey(input, 4_000)
    assert.equal(k, curatorCacheKey({ ...input }, 4_000))
    assert.notEqual(k, curatorCacheKey({ ...input, task: 'Add invoices' }, 4_000))
    assert.notEqual(k, curatorCacheKey({ ...input, candidates: candidates.slice(0, 2) }, 4_000))
    assert.notEqual(k, curatorCacheKey({ ...input, model: 'gpt-mini' }, 4_000))
  })

  it('keeps only real candidate ids, always counts pinned ones, and adds the profile', () => {
    const out = assembleCurated('SHOP-4', 'GPT-5.5', '- Refund in minor units (Use minor units)', '**Shop** profile', [ID(2), 'made-up-id'], candidates, 4_000)
    assert.deepEqual(out.itemIds.sort(), [ID(1), ID(2)].sort())
    assert.match(out.markdown, /curated for this task \(GPT-5\.5\)/)
    assert.match(out.markdown, /### For this task\n- Refund in minor units/)
    assert.match(out.markdown, /### Project profile\n\*\*Shop\*\* profile/)
    assert.match(out.markdown, /sdlc_get_memory/)
  })

  // A fake DB: an empty cache that records inserts.
  function fakeDb() {
    const inserted: unknown[] = []
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: async () => [],
      insert: () => ({ values: (v: unknown) => ({ onConflictDoNothing: async () => inserted.push(v) }) }),
      delete: () => ({ where: async () => undefined }),
    }
    return { db: chain as unknown as Db, inserted }
  }
  const runtime = { config: { enabled: true } } as unknown as ChatRuntime
  const log = { warn: () => undefined }

  it('returns the curated brief and caches it', async () => {
    const { db, inserted } = fakeDb()
    const curator = createContextCurator(db, runtime, log, { callModel: async () => ({ output: { brief: '- Use minor units', usedItemIds: [ID(2)] }, model: 'stub' }) })
    const out = await curator.curate(input)
    assert.ok(out)
    assert.equal(out.model, 'stub')
    assert.deepEqual(out.itemIds.sort(), [ID(1), ID(2)].sort())
    assert.equal(inserted.length, 1)
  })

  it('falls back (null) when the model is too slow or fails, and skips an empty candidate list', async () => {
    const { db } = fakeDb()
    const slow = createContextCurator(db, runtime, log, { timeoutMs: 30, callModel: () => new Promise((r) => setTimeout(() => r({ output: { brief: 'late', usedItemIds: [] }, model: 's' }), 500)) })
    assert.equal(await slow.curate(input), null)
    const failing = createContextCurator(db, runtime, log, { callModel: async () => Promise.reject(new Error('boom')) })
    assert.equal(await failing.curate(input), null)
    assert.equal(await failing.curate({ ...input, candidates: [] }), null)
  })
})

describe('AI settings', () => {
  it('older projects get the defaults; invalid fields fall back', () => {
    assert.deepEqual(readProjectSettings({}).ai, DEFAULT_AI_SETTINGS)
    const s = readProjectSettings({ ai: { curateRunContext: true, profileDebounceSeconds: 5, profileModel: 'gpt-mini' } })
    assert.equal(s.ai.curateRunContext, true)
    assert.equal(s.ai.profileModel, 'gpt-mini')
    assert.equal(s.ai.profileDebounceSeconds, DEFAULT_AI_SETTINGS.profileDebounceSeconds)
  })

  it('an AI change keeps memory settings, and a memory change keeps AI settings', () => {
    const stored = readProjectSettings({ memory: { provideToRuns: false }, ai: { semanticSearch: false } })
    const ai = mergeProjectSettings(stored, { ai: { curateRunContext: true } })
    assert.equal(ai.memory.provideToRuns, false)
    assert.equal(ai.ai.semanticSearch, false)
    assert.equal(ai.ai.curateRunContext, true)
    const memory = mergeProjectSettings(stored, { memory: { captureLearnings: false } })
    assert.equal(memory.ai.semanticSearch, false)
  })

  it('validates a partial AI update', () => {
    assert.ok(UpdateProjectInputSchema.safeParse({ settings: { ai: { profileDebounceSeconds: 120, curatorModel: null } } }).success)
    assert.ok(!UpdateProjectInputSchema.safeParse({ settings: { ai: { profileDebounceSeconds: 5 } } }).success)
  })
})
