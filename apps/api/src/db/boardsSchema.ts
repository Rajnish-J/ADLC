// Azure Boards sync (migration 0012): which Azure DevOps project each platform project syncs from, which work item
// each synced story came from, and the Azure DevOps identity a user's work items are matched by. Kept in its own
// file (listed in drizzle.config.ts) — the tables only reference the core ones.

import { boolean, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { gitConnections, projects, stories, users } from './schema'

/** A project's Azure Boards link. No row = derived from its Azure Repos repository (if any), never synced yet. */
export const projectBoards = pgTable('project_boards', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  /** Azure DevOps organization. */
  organization: text('organization').notNull(),
  /** Azure DevOps project name. */
  adoProject: text('ado_project').notNull(),
  workItemTypes: text('work_item_types').array().notNull(),
  /** Only work items under this area path (migration 0020); null = the whole Azure DevOps project. */
  areaPath: text('area_path'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** The work item a story is synced from. One story per work item per project. */
export const storyExternalLinks = pgTable(
  'story_external_links',
  {
    storyId: uuid('story_id')
      .primaryKey()
      .references(() => stories.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** azure-boards */
    provider: text('provider').notNull(),
    /** The work item id, as text. */
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    itemType: text('item_type').notNull(),
    /** The work item's Azure DevOps state at the last sync. */
    state: text('state').notNull(),
    /** System.ChangedDate at the last sync: fields are refreshed only when the work item changed since. */
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('story_external_links_item_uq').on(t.projectId, t.provider, t.externalId),
    index('story_external_links_project_idx').on(t.projectId),
  ],
)

/** How a user appears in an external tracker (Azure DevOps: their email or UPN), when it isn't their platform email. */
export const userExternalIdentities = pgTable(
  'user_external_identities',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** azure-boards */
    provider: text('provider').notNull(),
    identity: text('identity').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })],
)

/**
 * A user's Azure DevOps access for "My work items" (migrations 0017–0018): queries run as the token's owner (`@Me`),
 * across every project of `organization`. One per user: either their own token (encrypted like Git connection
 * tokens, REPO_CREDENTIAL_KEY, never returned) or a link to an organisation Azure Git connection whose token is
 * theirs (`connection_id`; the connection's current token is used, so replacing it there carries over).
 */
export const userAdoTokens = pgTable('user_ado_tokens', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Azure DevOps organization (dev.azure.com/<organization>). */
  organization: text('organization').notNull(),
  /**
   * Linked Git connection; its token is used instead of `credential_enc`. Deleting the connection deletes this row
   * (a linked row has no token of its own, so nothing usable would be left): the user is asked to link or add again.
   */
  connectionId: uuid('connection_id').references(() => gitConnections.id, { onDelete: 'cascade' }),
  /** The user's own token; null when linked to a connection. */
  credentialEnc: text('credential_enc'),
  credentialHint: text('credential_hint'),
  /** The account Azure DevOps reported for the token when it was verified. */
  account: text('account'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
