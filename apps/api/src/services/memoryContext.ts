// The memory an agent run is given. A story run gets the story's own memory, pinned project knowledge, the
// project's conventions and decisions, and the project items most related to the story (full-text search); a quick
// fix (no story) gets the same project knowledge, related to its prompt. Returned as Markdown the extension writes to
// the session's memory.md, capped so it never crowds the prompt.
//
// Passing the run (and step) records which items the run was given, so its page can show the memory it used and
// people can rate each item's helpfulness. Only the run's owner records anything.

import { and, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import { MEMORY_KIND_LABELS, readProjectSettings, type MemoryContext, type MemoryContextQuerySchema, type MemoryKind } from '@sdlc/contracts'
import type { z } from 'zod'
import { loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import { memoryItems, runMemoryReads, runs } from '../db/schema'
import type { ServiceDeps } from './context'
import type { CuratorCandidate } from './contextCurator'
import { memoryColumns, type MemoryRecord } from './memoryPresent'
import { fuseRankings } from './memoryIndex'
import { acceptedProfileForRun } from './projectProfile'
import { loadStory } from './stories'

const MAX_CHARS = 12_000
const MAX_ITEM_CHARS = 600
/** Below this cosine similarity an item is not "related" (text-embedding-3: unrelated text scores ~0.1–0.2). */
const SEMANTIC_MIN_SCORE = 0.25
/** How many related items a curator chooses from. */
const CURATE_CANDIDATES = 20
const PINNED_HEADING = 'Pinned project knowledge'

type ContextQuery = z.output<typeof MemoryContextQuerySchema>

interface Section {
  heading: string
  items: Pick<MemoryRecord, 'id' | 'kind' | 'title' | 'content' | 'fileRefs'>[]
}

/** Render sections to Markdown, stopping (and saying so) once the budget is spent. Pure — unit-testable. */
export function formatMemoryContext(subject: string, sections: Section[], maxChars = MAX_CHARS): MemoryContext {
  const lines: string[] = [`Knowledge recorded on the SDLC platform for ${subject}. Follow the conventions and decisions unless the work item says otherwise.`]
  const itemIds: string[] = []
  let used = lines[0].length
  let truncated = false
  for (const section of sections) {
    if (section.items.length === 0 || truncated) continue
    const heading = `\n### ${section.heading}`
    lines.push(heading)
    used += heading.length
    for (const item of section.items) {
      const body = item.content.trim().replace(/\s+\n/g, '\n')
      const short = body.length > MAX_ITEM_CHARS ? `${body.slice(0, MAX_ITEM_CHARS).trimEnd()}…` : body
      const refs = item.fileRefs.length
        ? ` (files: ${item.fileRefs.map((f) => (f.startLine ? `${f.path}:${f.startLine}${f.endLine ? `-${f.endLine}` : ''}` : f.path)).join(', ')})`
        : ''
      const entry = `- **${MEMORY_KIND_LABELS[item.kind as MemoryKind]}: ${item.title}**${refs}${short ? `\n  ${short.replace(/\n/g, '\n  ')}` : ''}`
      if (used + entry.length + 1 > maxChars) {
        lines.push('- … more project memory exists; ask if you need it.')
        truncated = true
        break
      }
      lines.push(entry)
      itemIds.push(item.id)
      used += entry.length + 1
    }
  }
  if (itemIds.length === 0) return { markdown: '', itemIds: [] }
  return { markdown: lines.join('\n'), itemIds }
}

/**
 * Put the accepted project profile first (its own share of the budget — at most half, never more than 5,000
 * characters — so it is not cut to the per-item limit), followed by the memory items in what is left.
 */
export function withProfile(subject: string, profile: string, render: (budget: number) => MemoryContext, maxChars: number): MemoryContext {
  if (!profile) return render(maxChars)
  const section = `### Project profile\n${profile.trim()}`
  const memory = render(Math.max(1_000, maxChars - section.length - 2))
  if (!memory.markdown) {
    const intro = `Knowledge recorded on the SDLC platform for ${subject}. Follow the conventions and decisions unless the work item says otherwise.`
    return { markdown: `${intro}\n\n${section}`, itemIds: [] }
  }
  const [intro, ...rest] = memory.markdown.split('\n')
  return { markdown: [intro, '', section, ...rest].join('\n'), itemIds: memory.itemIds }
}

async function profileFor(db: Db, access: ProjectAccess, maxChars: number) {
  return acceptedProfileForRun(db, access.project.id, Math.min(5_000, Math.floor(maxChars / 2)))
}

/**
 * For a run: the project items it has proposed so far (awaiting a lead), so a later step of a quick fix sees what
 * an earlier step learned. Accepted items are already in the other sections. Nothing without a run.
 */
async function runProposals(db: Db, access: ProjectAccess, runId: string | undefined): Promise<Section[]> {
  if (!runId) return []
  const items = await db
    .select(memoryColumns)
    .from(memoryItems)
    .where(and(eq(memoryItems.projectId, access.project.id), eq(memoryItems.runId, runId), eq(memoryItems.status, 'proposed')))
    .orderBy(memoryItems.createdAt)
    .limit(20)
  return [{ heading: 'Proposed earlier in this run (awaiting a lead)', items }]
}

/** Distinct, sanitised words from the story to search project memory with (OR-ed, so any match ranks). */
export function searchTerms(text: string, max = 16): string[] {
  const stop = new Set(['that', 'this', 'with', 'from', 'have', 'want', 'when', 'will', 'should', 'able', 'into', 'their', 'there', 'what', 'which', 'every', 'each', 'they', 'them', 'than', 'then', 'only', 'also', 'more', 'some'])
  const seen = new Set<string>()
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 4 || stop.has(word) || seen.has(word)) continue
    seen.add(word)
    if (seen.size >= max) break
  }
  return [...seen]
}

/** Pinned project knowledge, conventions and decisions, and the items most related to `text`. */
/**
 * Pinned project knowledge, conventions and decisions, and the items most related to `text`. "Related" is keyword
 * full-text search, fused with semantic (embedding) search when the project has it on and its memory is indexed.
 */
async function projectSections(deps: ServiceDeps, access: ProjectAccess, text: string, related: number): Promise<Section[]> {
  const { db } = deps
  // The profile's memory item is left out: runs get the profile in its own section.
  const projectAccepted = and(eq(memoryItems.projectId, access.project.id), eq(memoryItems.scope, 'project'), eq(memoryItems.status, 'accepted'), ne(memoryItems.source, 'profile'))
  const pinned = await db.select(memoryColumns).from(memoryItems).where(and(projectAccepted, eq(memoryItems.pinned, true))).orderBy(desc(memoryItems.updatedAt)).limit(15)

  const taken = pinned.map((p) => p.id)
  const rules = await db
    .select(memoryColumns)
    .from(memoryItems)
    .where(and(projectAccepted, inArray(memoryItems.kind, ['convention', 'decision']), ...(taken.length ? [notInArray(memoryItems.id, taken)] : [])))
    .orderBy(desc(memoryItems.updatedAt))
    .limit(10)
  taken.push(...rules.map((r) => r.id))

  const terms = searchTerms(text)
  const query = terms.join(' | ')
  const keyword = terms.length
    ? await db
        .select(memoryColumns)
        .from(memoryItems)
        .where(and(projectAccepted, sql`${memoryItems.search} @@ to_tsquery('english', ${query})`, ...(taken.length ? [notInArray(memoryItems.id, taken)] : [])))
        .orderBy(desc(sql`ts_rank(${memoryItems.search}, to_tsquery('english', ${query}))`))
        .limit(related * 2)
    : []

  let relatedItems = keyword.slice(0, related)
  const index = deps.memoryIndex
  if (index && (await index.usable(access.project.id, access.project.settings))) {
    const semantic = await index.similar(access.project.id, text, { limit: Math.max(12, related), excludeIds: taken, minScore: SEMANTIC_MIN_SCORE })
    if (semantic?.length) {
      const order = fuseRankings([keyword.map((k) => k.id), semantic.map((x) => x.id)]).slice(0, related)
      const byId = new Map(keyword.map((k) => [k.id, k]))
      const missing = order.filter((id) => !byId.has(id))
      if (missing.length) for (const row of await db.select(memoryColumns).from(memoryItems).where(inArray(memoryItems.id, missing))) byId.set(row.id, row)
      relatedItems = order.map((id) => byId.get(id)).filter((r): r is MemoryRecord => Boolean(r))
    }
  }

  return [
    { heading: PINNED_HEADING, items: pinned },
    { heading: 'Project conventions and decisions', items: rules },
    { heading: 'Related project knowledge', items: relatedItems },
  ]
}

/**
 * Record that a run was given these items. Only the run's owner records (anyone in the project may read memory);
 * an item given again later (an agent asking for memory) keeps its first record. Returns how many were new.
 */
async function recordReads(db: Db, access: ProjectAccess, user: AuthUser, query: ContextQuery, itemIds: string[]): Promise<number> {
  if (!query.runId || itemIds.length === 0) return 0
  const [run] = await db
    .select({ userId: runs.userId })
    .from(runs)
    .where(and(eq(runs.id, query.runId), eq(runs.projectId, access.project.id)))
    .limit(1)
  if (!run || run.userId !== user.id) return 0
  const rows = await db
    .insert(runMemoryReads)
    .values(itemIds.map((memoryItemId) => ({ runId: query.runId as string, memoryItemId, stepId: query.stepId ?? null, via: query.via })))
    .onConflictDoNothing()
    .returning({ id: runMemoryReads.memoryItemId })
  return rows.length
}

function announce(deps: ServiceDeps, access: ProjectAccess, storyNumber: number | null, runId: string, actorId: string): void {
  deps.bus.publish({ type: 'work.changed', projectKey: access.project.key, storyNumber, kind: 'run', actorId, runId })
}

/** The project turned "give memory to runs" off (Project settings → Memory): runs get nothing. */
const MEMORY_OFF: MemoryContext = { markdown: '', itemIds: [] }

/** The candidates a curator chooses from: every item in the sections, labelled with its section. */
function candidatesOf(sections: Section[]): CuratorCandidate[] {
  return sections.flatMap((sec) =>
    sec.items.map((i) => ({
      id: i.id,
      section: sec.heading,
      kind: MEMORY_KIND_LABELS[i.kind as MemoryKind],
      title: i.title,
      content: i.content,
      pinned: sec.heading === PINNED_HEADING,
    })),
  )
}

/**
 * The memory a run gets: assembled (profile + sections within the budget), or — when the project curates run
 * context and the model answers — a focused brief written for this task. An agent asking for memory itself
 * (`via: 'tool'`) always gets the full assembled memory.
 */
async function buildContext(
  deps: ServiceDeps,
  access: ProjectAccess,
  args: { subject: string; task: string; sections: (related: number) => Promise<Section[]>; related: number; via: ContextQuery['via'] },
): Promise<{ context: MemoryContext; profileItemId: string | null }> {
  const settings = readProjectSettings(access.project.settings)
  const budget = settings.memory.contextBudget
  const found = await profileFor(deps.db, access, budget)
  const profile = found?.markdown ?? ''
  // The profile is always given when there is one (withProfile, or as the curator's input): say which version, and
  // let the run record its mirrored memory item ("Project profile vN") so the run page shows it was used.
  const given = (context: MemoryContext) => ({
    context: { ...context, profileVersion: found?.version ?? null },
    profileItemId: found?.memoryItemId ?? null,
  })
  if (settings.ai.curateRunContext && deps.curator && args.via !== 'tool') {
    const sections = await args.sections(CURATE_CANDIDATES)
    const curated = await deps.curator.curate({
      projectId: access.project.id,
      subject: args.subject,
      task: args.task,
      profile,
      candidates: candidatesOf(sections),
      budget,
      model: settings.ai.curatorModel,
    })
    if (curated) return given({ markdown: curated.markdown, itemIds: curated.itemIds, curated: true, model: curated.model })
    return given(withProfile(args.subject, profile, (b) => formatMemoryContext(args.subject, sections, b), budget))
  }
  const sections = await args.sections(args.related)
  return given(withProfile(args.subject, profile, (b) => formatMemoryContext(args.subject, sections, b), budget))
}

/** The ids to record as read: the items given, plus the profile's memory item when the profile was given. */
export const readIds = (context: MemoryContext, profileItemId: string | null): string[] =>
  profileItemId && context.markdown && !context.itemIds.includes(profileItemId) ? [...context.itemIds, profileItemId] : context.itemIds

export async function storyMemoryContext(deps: ServiceDeps, user: AuthUser, key: string, number: number, query: ContextQuery): Promise<MemoryContext> {
  const { db } = deps
  const access = await loadProjectAccess(db, user, key)
  const policy = readProjectSettings(access.project.settings).memory
  if (!policy.provideToRuns) return MEMORY_OFF
  const story = await loadStory(db, access, number)
  const storyItems = await db
    .select(memoryColumns)
    .from(memoryItems)
    .where(and(eq(memoryItems.projectId, access.project.id), eq(memoryItems.scope, 'story'), eq(memoryItems.storyId, story.id), eq(memoryItems.status, 'accepted')))
    .orderBy(memoryItems.createdAt)
    .limit(30)
  const task = [story.title, story.description, query.q ?? ''].filter(Boolean).join('\n\n')
  const proposals = await runProposals(db, access, query.runId)
  const { context, profileItemId } = await buildContext(deps, access, {
    subject: `${access.project.key}-${number} and its project`,
    task,
    related: 5,
    via: query.via,
    sections: async (related) => [{ heading: 'This story’s memory', items: storyItems }, ...proposals, ...(await projectSections(deps, access, task, related))],
  })
  if ((await recordReads(db, access, user, query, readIds(context, profileItemId))) > 0 && query.runId) announce(deps, access, number, query.runId, user.id)
  return context
}

/** For a quick fix: the project's knowledge, with the items most related to its prompt. */
export async function projectMemoryContext(deps: ServiceDeps, user: AuthUser, key: string, query: ContextQuery): Promise<MemoryContext> {
  const { db } = deps
  const access = await loadProjectAccess(db, user, key)
  const policy = readProjectSettings(access.project.settings).memory
  if (!policy.provideToRuns) return MEMORY_OFF
  const task = query.q ?? ''
  const proposals = await runProposals(db, access, query.runId)
  const { context, profileItemId } = await buildContext(deps, access, {
    subject: `the ${access.project.key} project`,
    task,
    related: 8,
    via: query.via,
    sections: async (related) => [...proposals, ...(await projectSections(deps, access, task, related))],
  })
  if ((await recordReads(db, access, user, query, readIds(context, profileItemId))) > 0 && query.runId) announce(deps, access, null, query.runId, user.id)
  return context
}
