// The project profile (migration 0021): one row per version. Kept in its own file (listed in drizzle.config.ts) —
// the table only references the core ones. At most one accepted version and one open (generating / proposed)
// version per project; older accepted versions become `superseded`.

import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { PROFILE_STATUSES, PROFILE_TRIGGERS, type ProfileContent } from '@sdlc/contracts'
import { organizations, projects, users } from './schema'

export const profileStatus = pgEnum('profile_status', PROFILE_STATUSES)
export const profileTrigger = pgEnum('profile_trigger', PROFILE_TRIGGERS)

export const projectProfiles = pgTable(
  'project_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: profileStatus('status').notNull().default('generating'),
    trigger: profileTrigger('trigger').notNull().default('manual'),
    branch: text('branch'),
    commitSha: text('commit_sha'),
    content: jsonb('content').$type<ProfileContent>(),
    markdown: text('markdown').notNull().default(''),
    aiWritten: boolean('ai_written').notNull().default(true),
    inputHash: text('input_hash'),
    model: text('model'),
    error: text('error'),
    runIds: uuid('run_ids').array().notNull().default(sql`'{}'::uuid[]`),
    basedOnId: uuid('based_on_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionComment: text('decision_comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_profiles_version_uq').on(t.projectId, t.version),
    uniqueIndex('project_profiles_accepted_uq').on(t.projectId).where(sql`${t.status} = 'accepted'`),
    uniqueIndex('project_profiles_open_uq').on(t.projectId).where(sql`${t.status} in ('generating', 'proposed')`),
    index('project_profiles_project_idx').on(t.projectId, t.createdAt),
  ],
)
