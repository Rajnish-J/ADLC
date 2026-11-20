// Azure Boards → platform stories. A project links to one Azure DevOps project; each user's assigned work items
// there are synced as stories of that project (assigned to them), linked back to the work item. The token is the
// organisation's Azure Git connection (Settings › Git connections), which needs the Work Items (Read) scope; the
// work items are matched to a user by their email, or by the Azure DevOps identity they set in Settings.

import { z } from 'zod'
import { parseRepoUrl } from './repo'
import type { StoryPriority, StoryStatus } from './stories'

export const DEFAULT_BOARDS_WORK_ITEM_TYPES = ['User Story', 'Product Backlog Item', 'Requirement', 'Bug', 'Task', 'Issue'] as const

export const AzureBoardsSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Azure DevOps organization (dev.azure.com/<organization>). */
  organization: z.string().trim().min(1).max(100),
  /** Azure DevOps project name. */
  project: z.string().trim().min(1).max(200),
  /** Work item types synced as stories. */
  workItemTypes: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  /** Only work items under this area path (e.g. `Product Hub\Synfra`); null = the whole project. */
  areaPath: z
    .string()
    .trim()
    .max(400)
    .nullish()
    .transform((v) => v || null),
})
export type AzureBoardsSettings = z.infer<typeof AzureBoardsSettingsSchema>

/** A project's Azure Boards link as the API returns it: stored settings, else defaults from its Azure repository. */
export const ProjectBoardsSchema = z.object({
  /** Null when nothing is stored and the repository isn't on Azure Repos. */
  settings: AzureBoardsSettingsSchema.nullable(),
  /** True when `settings` were derived from the linked repository and never saved. */
  derived: z.boolean(),
  /** Whether the organisation has an Azure Git connection for `settings.organization`. */
  hasConnection: z.boolean(),
  lastSyncedAt: z.string().nullable(),
})
export type ProjectBoards = z.infer<typeof ProjectBoardsSchema>

export const UpdateProjectBoardsInputSchema = AzureBoardsSettingsSchema
export type UpdateProjectBoardsInput = z.input<typeof UpdateProjectBoardsInputSchema>

/**
 * POST /projects/:key/boards/prune: the stories synced from work items outside the project's area (e.g. imported
 * before the area was set). With `dryRun` they are only listed; otherwise they are deleted.
 */
export const BoardsPruneResultSchema = z.object({
  areaPath: z.string(),
  stories: z.array(z.object({ number: z.number().int(), title: z.string(), workItemId: z.number().int(), areaPath: z.string() })),
  /** How many runs those stories have: deleting a story deletes its runs and their history too. */
  runs: z.number().int().nonnegative().default(0),
  removed: z.boolean(),
})
export type BoardsPruneResult = z.infer<typeof BoardsPruneResultSchema>

/** GET /projects/:key/boards/areas: an Azure DevOps project's area paths, root first. */
export const BoardsAreasSchema = z.object({ areas: z.array(z.string()) })
export type BoardsAreas = z.infer<typeof BoardsAreasSchema>

/** The area path whose last segment matches a platform project's name or key (ignoring case, spaces and dashes). */
export function suggestAreaPath(areas: readonly string[], names: readonly string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wanted = new Set(names.map(norm).filter(Boolean))
  return areas.slice(1).find((a) => wanted.has(norm(a.split('\\').pop() ?? ''))) ?? null
}

/** The work item a synced story is linked to. */
export const StoryExternalSchema = z.object({
  provider: z.literal('azure-boards'),
  /** The work item id, as text. */
  id: z.string(),
  url: z.string(),
  /** Work item type ("User Story", "Bug"…). */
  type: z.string(),
  /** Its Azure DevOps state ("Active", "Closed"…). */
  state: z.string(),
})
export type StoryExternal = z.infer<typeof StoryExternalSchema>

/** The identity Azure DevOps work items are matched against for the signed-in user. */
export const BoardsIdentitySchema = z.object({
  /** What is matched against System.AssignedTo: the override, else the user's email. */
  identity: z.string(),
  /** The user's own override (email or UPN), or null to use their email. */
  override: z.string().nullable(),
})
export type BoardsIdentity = z.infer<typeof BoardsIdentitySchema>

export const UpdateBoardsIdentityInputSchema = z.object({
  /** Email or UPN as shown in Azure DevOps; null or '' clears it. */
  identity: z
    .string()
    .trim()
    .max(254)
    .nullable()
    .transform((v) => (v ? v : null)),
})
export type UpdateBoardsIdentityInput = z.infer<typeof UpdateBoardsIdentityInputSchema>

/** One project's result of syncing the caller's assigned work items. */
export const BoardsSyncResultSchema = z.object({
  projectKey: z.string(),
  created: z.number().int(),
  updated: z.number().int(),
  /** Work items assigned to the caller there (before filtering long-closed ones). */
  found: z.number().int(),
  /** Why this project could not be synced; null on success. */
  error: z.string().nullable(),
})
export type BoardsSyncResult = z.infer<typeof BoardsSyncResultSchema>

export const BoardsSyncResponseSchema = z.object({
  results: z.array(BoardsSyncResultSchema),
  /** True when the sync was skipped because one ran moments ago. */
  throttled: z.boolean().default(false),
})
export type BoardsSyncResponse = z.infer<typeof BoardsSyncResponseSchema>

// ─── My work items: the user's own token, every project of their Azure DevOps organization ───────

/** The signed-in user's own Azure DevOps token, as the API shows it (never the token itself). */
export const AdoTokenStatusSchema = z.object({
  /** `token`: the user's own; `connection`: a linked organisation Git connection (its current token is used). */
  source: z.enum(['token', 'connection']),
  /** The linked connection's name (source `connection`). */
  connectionName: z.string().nullable(),
  organization: z.string(),
  /** The account Azure DevOps reported for the token. */
  account: z.string().nullable(),
  /** The token's last characters (`…abcd`). */
  hint: z.string(),
  verifiedAt: z.string(),
})
export type AdoTokenStatus = z.infer<typeof AdoTokenStatusSchema>

/**
 * An organisation Azure Git connection the user could use for My work items. Usable only when its token is the
 * user's (they added it, or its account is their Azure DevOps identity) — `@Me` is whoever owns the token.
 */
export const AdoConnectionSuggestionSchema = z.object({
  connectionId: z.string(),
  name: z.string(),
  organization: z.string(),
  /** The account Azure DevOps reported for its token. */
  account: z.string().nullable(),
  hint: z.string(),
  usable: z.boolean(),
  /** Why it can't be used (when not usable). */
  reason: z.string().nullable(),
})
export type AdoConnectionSuggestion = z.infer<typeof AdoConnectionSuggestionSchema>

/** GET / PUT /me/ado-token: the stored access (null when none) and the Git connections that could be linked. */
export const AdoTokenResponseSchema = z.object({
  token: AdoTokenStatusSchema.nullable(),
  suggestions: z.array(AdoConnectionSuggestionSchema).default([]),
})
export type AdoTokenResponse = z.infer<typeof AdoTokenResponseSchema>

export const SetAdoTokenInputSchema = z.object({
  /** dev.azure.com/<organization>; a pasted URL is reduced to the organization. */
  organization: z
    .string()
    .trim()
    .transform((v) => v.replace(/^(https?:\/\/)?(dev\.azure\.com\/)?/i, '').replace(/\.visualstudio\.com.*$/i, '').split('/')[0] ?? '')
    .pipe(z.string().min(1, 'Enter the Azure DevOps organization.').max(100)),
  token: z.string().trim().min(1, 'Paste the personal access token.').max(1000),
})
export type SetAdoTokenInput = z.infer<typeof SetAdoTokenInputSchema>

/** Use an organisation Azure Git connection (whose token is the user's) instead of adding a token. */
export const LinkAdoConnectionInputSchema = z.object({ connectionId: z.string().uuid() })
export type LinkAdoConnectionInput = z.infer<typeof LinkAdoConnectionInputSchema>

export const ADO_STATE_CATEGORIES = ['Proposed', 'InProgress', 'Resolved', 'Completed'] as const
export type AdoBoardCategory = (typeof ADO_STATE_CATEGORIES)[number]

/** Column titles for the state categories (every process maps its states onto these). */
export const ADO_STATE_CATEGORY_LABELS: Record<AdoBoardCategory, string> = {
  Proposed: 'New',
  InProgress: 'Active',
  Resolved: 'Resolved',
  Completed: 'Closed',
}

/** One work item assigned to the user, read live from Azure DevOps. */
export const MyWorkItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  /** Work item type ("User Story", "Bug", "Task"…). */
  type: z.string(),
  /** Its Azure DevOps state ("Active", "Closed"…). */
  state: z.string(),
  /** The state's category: which board column it goes in. */
  category: z.enum(ADO_STATE_CATEGORIES),
  /** The Azure DevOps project it lives in. */
  project: z.string(),
  /** Area path, e.g. `Product Hub\Synfra`. */
  areaPath: z.string(),
  /** Iteration path, e.g. `Product Hub\Sprint 12`. */
  iterationPath: z.string(),
  /** The parent work item (e.g. the user story a task belongs to). */
  parent: z.object({ id: z.number().int(), title: z.string() }).nullable(),
  /** 1 (highest) – 4, or null. */
  priority: z.number().int().nullable(),
  tags: z.array(z.string()),
  changedAt: z.string(),
  url: z.string(),
  /** The platform story synced from this work item, if any. */
  linkedStory: z.object({ projectKey: z.string(), number: z.number().int() }).nullable(),
})
export type MyWorkItem = z.infer<typeof MyWorkItemSchema>

export const MyWorkItemsResponseSchema = z.object({
  organization: z.string(),
  fetchedAt: z.string(),
  /** True when there were more than the board shows (it shows the most recently changed). */
  truncated: z.boolean(),
  items: z.array(MyWorkItemSchema),
})
export type MyWorkItemsResponse = z.infer<typeof MyWorkItemsResponseSchema>

// ─── Mapping (shared so the web, the extension and the API agree) ────────────────────────────────

/** Azure DevOps state category → story status. */
export function storyStatusForCategory(category: string): StoryStatus {
  switch (category) {
    case 'Proposed':
      return 'ready'
    case 'Resolved':
      return 'in_review'
    case 'Completed':
    case 'Removed':
      return 'done'
    default:
      return 'in_progress'
  }
}

/** Azure DevOps priority (1 highest – 4) → story priority. */
export function storyPriorityForAdo(priority: number | null | undefined): StoryPriority {
  switch (priority) {
    case 1:
      return 'critical'
    case 2:
      return 'high'
    case 4:
      return 'low'
    default:
      return 'medium'
  }
}

/** Azure DevOps tags → story labels (lowercase, dash-separated, at most 10 of 32 characters — the story label rules). */
export function labelsForAdoTags(tags: readonly string[]): string[] {
  const out = tags
    .map((t) =>
      t
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32), // MAX_LABEL_LENGTH
    )
    .filter(Boolean)
  return [...new Set(out)].slice(0, 10)
}

/** Default Azure Boards settings for a project whose repository is on Azure Repos (null otherwise). */
export function boardsDefaultsFromRepo(remoteUrl: string | null | undefined): AzureBoardsSettings | null {
  if (!remoteUrl) return null
  const parsed = parseRepoUrl(remoteUrl)
  if (!parsed.ok || parsed.repo.provider !== 'azure-repos' || !parsed.repo.project) return null
  return { enabled: true, organization: parsed.repo.owner, project: parsed.repo.project, workItemTypes: [...DEFAULT_BOARDS_WORK_ITEM_TYPES], areaPath: null }
}

/** Label for a story's work item link: `ADO #1234`. */
export function externalLabel(external: StoryExternal): string {
  return `ADO #${external.id}`
}
