// AI-curated run context (Project settings → Memory → AI & context → "Curate run context"). Instead of handing an
// agent every candidate memory item, the model reads the task and the candidates and writes a focused brief: the
// rules, decisions and learnings that matter for THIS work, naming the items it used. The project profile follows,
// and the agent can still ask for everything through its memory tool.
//
// Cached by the hash of everything the brief is written from, so every step of a run (and a re-run of the same
// task with the same memory) reuses it. Never blocks a run: on a timeout or any error the caller falls back to the
// assembled context.

import { createHash } from 'node:crypto'
import { generateText, Output } from 'ai'
import { eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import type { ChatRuntime } from '../chat/llm'
import type { Db } from '../db/client'
import { memoryContextCache } from '../db/embeddingSchema'

interface Logger {
  warn(obj: unknown, msg?: string): void
}

export const CURATOR_PROMPT_VERSION = 'v1'
const CACHE_DAYS = 7

export interface CuratorCandidate {
  id: string
  /** Where it came from: "This story's memory", "Pinned project knowledge", … */
  section: string
  kind: string
  title: string
  content: string
  pinned: boolean
}

export interface CurateInput {
  projectId: string
  subject: string
  /** The work: story title and description, or the quick fix's prompt. */
  task: string
  /** Compact project profile ('' when none). */
  profile: string
  candidates: CuratorCandidate[]
  /** Characters the whole memory.md may use. */
  budget: number
  /** Deployment id; null = the default model. */
  model: string | null
}

export interface CuratedContext {
  markdown: string
  itemIds: string[]
  model: string
}

const CuratorOutputSchema = z.object({
  brief: z.string().describe('Markdown brief for the agent: the memory that matters for this task, grouped under short bold labels.'),
  usedItemIds: z.array(z.string()).describe('Ids of the candidate items the brief relies on.'),
})
type CuratorOutput = z.infer<typeof CuratorOutputSchema>

export const CURATOR_SYSTEM = `You prepare the project knowledge an AI coding agent gets before it starts a task.
You receive the task and candidate memory items (decisions, conventions, learnings, notes, summaries) recorded by the team.
Write a focused brief in Markdown for THIS task:
- Keep every pinned item's rule (they always apply), stated briefly.
- Then the conventions, decisions and learnings that are relevant to the task — skip the ones that are not.
- Be concrete and imperative ("Store amounts in minor units"), name files when the items do, and put the item title in parentheses after each point.
- Never invent rules or facts that are not in the candidates. If nothing beyond the pinned items is relevant, say so in one line.
- No preamble and no heading at the top. List the ids of the items you used in usedItemIds.`

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text)

/** The model's input. Deterministic — its hash is the cache key. Pure, unit-tested. */
export function curatorPrompt(input: CurateInput, briefBudget: number): string {
  const lines = [`# Task`, clip(input.task.trim() || '(no description)', 3_000), '', `# Candidate memory (${input.candidates.length})`]
  for (const c of input.candidates) {
    lines.push('', `## [${c.id}] ${c.kind}${c.pinned ? ' · PINNED' : ''} — ${c.title}`, `Section: ${c.section}`, clip(c.content.trim(), 1_200))
  }
  lines.push('', `---`, `Write the brief in at most ${briefBudget} characters.`)
  return lines.join('\n')
}

export function curatorCacheKey(input: CurateInput, briefBudget: number): string {
  return createHash('sha256')
    .update([CURATOR_PROMPT_VERSION, input.projectId, input.model ?? 'default', String(briefBudget), input.profile, curatorPrompt(input, briefBudget)].join('\n'))
    .digest('hex')
}

/** The memory.md an agent gets from a curated brief. Pure, unit-tested. */
export function assembleCurated(subject: string, model: string, brief: string, profile: string, usedIds: string[], candidates: CuratorCandidate[], briefBudget: number) {
  const known = new Set(candidates.map((c) => c.id))
  const pinned = candidates.filter((c) => c.pinned).map((c) => c.id)
  // Pinned items are always in force, so they count as used even if the model forgot to list them.
  const itemIds = [...new Set([...pinned, ...usedIds.filter((id) => known.has(id))])]
  const lines = [
    `Knowledge recorded on the SDLC platform for ${subject}, curated for this task (${model}). Follow it unless the work item says otherwise.`,
    '',
    '### For this task',
    clip(brief.trim() || '_No recorded memory applies beyond the project profile._', briefBudget),
  ]
  if (profile.trim()) lines.push('', '### Project profile', profile.trim())
  lines.push('', '_The full project and story memory is available through your memory tool (sdlc_get_memory)._')
  return { markdown: lines.join('\n'), itemIds }
}

export interface ContextCurator {
  curate(input: CurateInput): Promise<CuratedContext | null>
}

export interface CuratorOptions {
  timeoutMs?: number
  /** Tests: replaces the model call. */
  callModel?: (system: string, prompt: string, model: string | null) => Promise<{ output: CuratorOutput; model: string }>
}

export function createContextCurator(db: Db, runtime: ChatRuntime, log: Logger, options: CuratorOptions = {}): ContextCurator {
  const timeoutMs = options.timeoutMs ?? 20_000

  async function callModel(system: string, prompt: string, modelId: string | null): Promise<{ output: CuratorOutput; model: string }> {
    if (options.callModel) return options.callModel(system, prompt, modelId)
    const { model, info } = runtime.model(modelId)
    const result = await generateText({
      model,
      system,
      prompt,
      output: Output.object({ schema: CuratorOutputSchema }),
      maxOutputTokens: 6_000,
      abortSignal: AbortSignal.timeout(timeoutMs),
    })
    return { output: result.output as CuratorOutput, model: info.label }
  }

  async function curate(input: CurateInput): Promise<CuratedContext | null> {
    if (!options.callModel && !runtime.config.enabled) return null
    if (!input.candidates.length) return null
    const briefBudget = Math.max(1_000, input.budget - input.profile.length - 400)
    const key = curatorCacheKey(input, briefBudget)
    try {
      const [hit] = await db.select().from(memoryContextCache).where(eq(memoryContextCache.keyHash, key)).limit(1)
      if (hit) return { markdown: hit.markdown, itemIds: hit.itemIds, model: hit.model ?? 'AI' }

      const out = await Promise.race([
        callModel(CURATOR_SYSTEM, curatorPrompt(input, briefBudget), input.model),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Curating took longer than ${timeoutMs / 1000} s`)), timeoutMs).unref?.()),
      ])
      const assembled = assembleCurated(input.subject, out.model, out.output.brief, input.profile, out.output.usedItemIds, input.candidates, briefBudget)
      await db
        .insert(memoryContextCache)
        .values({ keyHash: key, projectId: input.projectId, markdown: assembled.markdown, itemIds: assembled.itemIds, model: out.model })
        .onConflictDoNothing()
      await db.delete(memoryContextCache).where(lt(memoryContextCache.createdAt, new Date(Date.now() - CACHE_DAYS * 86_400_000)))
      return { ...assembled, model: out.model }
    } catch (err) {
      log.warn({ err, projectId: input.projectId }, 'Curating run context failed; giving the assembled memory instead')
      return null
    }
  }

  return { curate }
}
