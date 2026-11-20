// Platform Chat (migration 0013): conversation threads with the specialist assistants, their messages (AI SDK
// UIMessages, stored whole), and the drafts the assistants build for Review & submit. Kept in its own file
// (listed in drizzle.config.ts) — the tables only reference the core ones.

import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { DraftResult } from '@sdlc/contracts'
import { organizations, projects, users } from './schema'

export const chatThreads = pgTable(
  'chat_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Threads are private to the user who started them. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New chat'),
    /** The assistant picked last (`default`, `workflows`, …). */
    agent: text('agent').notNull().default('default'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('chat_threads_user_idx').on(t.userId, t.updatedAt)],
)

export const chatMessages = pgTable(
  'chat_messages',
  {
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    /** The AI SDK message id — unique per thread; an updated message (approvals, answers) replaces its row. */
    id: text('id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    parts: jsonb('parts').$type<unknown[]>().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.id] }), index('chat_messages_thread_seq_idx').on(t.threadId, t.seq)],
)

export const chatDrafts = pgTable(
  'chat_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    /** workflow | project | agent | skill | stories */
    kind: text('kind').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** Editing an existing item: workflow id, agent/skill slug or project key. Null = create. */
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    data: jsonb('data').$type<unknown>().notNull(),
    openQuestions: jsonb('open_questions').$type<string[]>().notNull().default([]),
    ready: boolean('ready').notNull().default(false),
    /** open | submitted | discarded */
    status: text('status').notNull().default('open'),
    result: jsonb('result').$type<DraftResult>(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
  },
  (t) => [
    index('chat_drafts_thread_idx').on(t.threadId),
    // One open draft per thread and kind: the assistant keeps refining it rather than starting another.
    index('chat_drafts_open_idx').on(t.threadId, t.kind).where(sql`${t.status} = 'open'`),
  ],
)
