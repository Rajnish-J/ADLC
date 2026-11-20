// Chat persistence: threads (private to their user), their messages (AI SDK UIMessages, upserted by id) and the
// drafts the specialists build. Every read is scoped to the calling user — another user's thread is a 404.

import { and, asc, desc, eq, inArray, isNull, max } from 'drizzle-orm'
import type { UIMessage } from 'ai'
import {
  DRAFT_DATA_SCHEMAS,
  EMPTY_DRAFT_DATA,
  type ChatDraft,
  type ChatThreadSummary,
  type DraftKind,
  type DraftResult,
} from '@sdlc/contracts'
import type { AuthUser } from '../auth'
import type { Db, Tx } from '../db/client'
import { chatDrafts, chatMessages, chatThreads } from '../db/chatSchema'
import { projects } from '../db/schema'
import { conflict, notFound } from '../http'

export type ThreadRow = typeof chatThreads.$inferSelect
export type DraftRow = typeof chatDrafts.$inferSelect

export const NEW_CHAT_TITLE = 'New chat'

async function projectKeys(db: Db | Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  const rows = await db.select({ id: projects.id, key: projects.key }).from(projects).where(inArray(projects.id, wanted))
  return new Map(rows.map((r) => [r.id, r.key]))
}

export function toThreadSummary(t: ThreadRow, projectKey: string | null): ChatThreadSummary {
  return { id: t.id, title: t.title, agent: t.agent, projectKey, model: t.model, updatedAt: t.updatedAt.toISOString() }
}

export async function listThreads(db: Db, user: AuthUser, limit = 50): Promise<ChatThreadSummary[]> {
  const rows = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.userId, user.id), isNull(chatThreads.archivedAt)))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(limit)
  const keys = await projectKeys(db, rows.map((r) => r.projectId))
  return rows.map((r) => toThreadSummary(r, r.projectId ? (keys.get(r.projectId) ?? null) : null))
}

export async function loadThread(db: Db | Tx, user: AuthUser, id: string): Promise<ThreadRow> {
  const [row] = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, id), eq(chatThreads.userId, user.id), isNull(chatThreads.archivedAt)))
    .limit(1)
  if (!row) throw notFound('Chat')
  return row
}

export async function threadProjectKey(db: Db | Tx, thread: ThreadRow): Promise<string | null> {
  if (!thread.projectId) return null
  return (await projectKeys(db, [thread.projectId])).get(thread.projectId) ?? null
}

export async function createThread(
  db: Db,
  user: AuthUser,
  input: { agent: string; projectId: string | null; model: string | null },
): Promise<ThreadRow> {
  const [row] = await db
    .insert(chatThreads)
    .values({ orgId: user.orgId, userId: user.id, agent: input.agent, projectId: input.projectId, model: input.model })
    .returning()
  return row
}

export async function updateThread(db: Db | Tx, id: string, set: Partial<Pick<ThreadRow, 'title' | 'agent' | 'projectId' | 'model' | 'archivedAt'>>): Promise<ThreadRow> {
  const [row] = await db
    .update(chatThreads)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(chatThreads.id, id))
    .returning()
  return row
}

// ─── Messages ───────────────────────────────────────────────────────────────────────────────────

export async function loadMessages(db: Db | Tx, threadId: string): Promise<UIMessage[]> {
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId)).orderBy(asc(chatMessages.seq))
  return rows.map((r) => ({ id: r.id, role: r.role as UIMessage['role'], parts: r.parts as UIMessage['parts'], ...(r.metadata ? { metadata: r.metadata } : {}) }))
}

/** Insert new messages at the end of the thread and replace existing ones (same id) in place. */
export async function saveMessages(db: Db, threadId: string, messages: UIMessage[]): Promise<void> {
  if (messages.length === 0) return
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.threadId, threadId))
    const known = new Set(existing.map((e) => e.id))
    const [{ top }] = await tx.select({ top: max(chatMessages.seq) }).from(chatMessages).where(eq(chatMessages.threadId, threadId))
    let seq = top ?? -1
    for (const m of messages) {
      const metadata = (m.metadata ?? null) as Record<string, unknown> | null
      if (known.has(m.id)) {
        await tx
          .update(chatMessages)
          .set({ parts: m.parts as unknown[], metadata, role: m.role })
          .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.id, m.id)))
      } else {
        seq += 1
        known.add(m.id)
        await tx.insert(chatMessages).values({ threadId, id: m.id, seq, role: m.role, parts: m.parts as unknown[], metadata })
      }
    }
    await tx.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, threadId))
  })
}

// ─── Drafts ─────────────────────────────────────────────────────────────────────────────────────

export async function toChatDraft(db: Db | Tx, d: DraftRow): Promise<ChatDraft> {
  const key = d.projectId ? ((await projectKeys(db, [d.projectId])).get(d.projectId) ?? null) : null
  return {
    id: d.id,
    threadId: d.threadId,
    kind: d.kind as DraftKind,
    projectKey: key,
    targetId: d.targetId,
    targetLabel: d.targetLabel,
    data: d.data,
    openQuestions: d.openQuestions,
    ready: d.ready,
    status: d.status as ChatDraft['status'],
    result: d.result ?? null,
    version: d.version,
    updatedAt: d.updatedAt.toISOString(),
  }
}

export async function listDrafts(db: Db | Tx, threadId: string): Promise<DraftRow[]> {
  return db.select().from(chatDrafts).where(eq(chatDrafts.threadId, threadId)).orderBy(asc(chatDrafts.createdAt))
}

/** The draft of `kind` the assistant is working on in this thread, if any. */
export async function openDraft(db: Db | Tx, threadId: string, kind: DraftKind): Promise<DraftRow | null> {
  const [row] = await db
    .select()
    .from(chatDrafts)
    .where(and(eq(chatDrafts.threadId, threadId), eq(chatDrafts.kind, kind), eq(chatDrafts.status, 'open')))
    .orderBy(desc(chatDrafts.updatedAt))
    .limit(1)
  return row ?? null
}

/** A draft the user owns (through its thread). */
export async function loadDraft(db: Db | Tx, user: AuthUser, id: string): Promise<{ draft: DraftRow; thread: ThreadRow }> {
  const [row] = await db
    .select({ draft: chatDrafts, thread: chatThreads })
    .from(chatDrafts)
    .innerJoin(chatThreads, eq(chatThreads.id, chatDrafts.threadId))
    .where(and(eq(chatDrafts.id, id), eq(chatThreads.userId, user.id)))
    .limit(1)
  if (!row) throw notFound('Draft')
  return row
}

/**
 * Save the assistant's current version of a draft: replaces the open draft of that kind, or starts one.
 * `target` (edit mode) is only set when a draft starts — a draft never switches between create and edit.
 */
export async function upsertDraft(
  db: Db | Tx,
  args: {
    threadId: string
    kind: DraftKind
    projectId: string | null
    data: unknown
    openQuestions: string[]
    ready: boolean
    target?: { id: string; label: string } | null
    /** Start a fresh draft even when one is open (loading another item to edit). */
    replace?: boolean
  },
): Promise<DraftRow> {
  const current = await openDraft(db, args.threadId, args.kind)
  if (current && args.replace) {
    await db.update(chatDrafts).set({ status: 'discarded', updatedAt: new Date() }).where(eq(chatDrafts.id, current.id))
  } else if (current) {
    const [row] = await db
      .update(chatDrafts)
      .set({
        data: args.data,
        openQuestions: args.openQuestions,
        ready: args.ready,
        projectId: current.projectId ?? args.projectId,
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(chatDrafts.id, current.id))
      .returning()
    return row
  }
  const [row] = await db
    .insert(chatDrafts)
    .values({
      threadId: args.threadId,
      kind: args.kind,
      projectId: args.projectId,
      targetId: args.target?.id ?? null,
      targetLabel: args.target?.label ?? null,
      data: args.data,
      openQuestions: args.openQuestions,
      ready: args.ready,
    })
    .returning()
  return row
}

/** The user's own edit from the Review form. */
export async function editDraft(db: Db, draft: DraftRow, version: number, data: unknown): Promise<DraftRow> {
  if (draft.status !== 'open') throw conflict('This draft was already submitted or discarded.')
  if (version !== draft.version) throw conflict('The assistant updated this draft while you were editing. Reload it and try again.')
  const parsed = DRAFT_DATA_SCHEMAS[draft.kind as DraftKind].safeParse(data)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw conflict(`${first?.path.join('.') || 'Draft'}: ${first?.message ?? 'invalid'}`)
  }
  const [row] = await db
    .update(chatDrafts)
    .set({ data: parsed.data, version: draft.version + 1, updatedAt: new Date() })
    .where(and(eq(chatDrafts.id, draft.id), eq(chatDrafts.version, version)))
    .returning()
  if (!row) throw conflict('The draft changed while you were editing. Reload it and try again.')
  return row
}

export async function setDraftStatus(db: Db | Tx, id: string, status: 'submitted' | 'discarded', result: DraftResult | null = null): Promise<DraftRow> {
  const [row] = await db
    .update(chatDrafts)
    .set({ status, result, updatedAt: new Date(), submittedAt: status === 'submitted' ? new Date() : null })
    .where(eq(chatDrafts.id, id))
    .returning()
  return row
}

/** An empty draft (before the assistant has saved one) — what Review shows for a kind with no draft yet. */
export const emptyDraftData = (kind: DraftKind): unknown => structuredClone(EMPTY_DRAFT_DATA[kind])
