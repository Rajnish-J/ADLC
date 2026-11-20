// Azure Boards work items assigned to a person — the read side of the platform's story sync. Pure HTTP against the
// Azure DevOps REST API (7.1): a WIQL query for the ids, batched GETs for the fields, and the work item types'
// state categories (to map any process's states onto story statuses). The caller passes the Authorization header
// (`Basic` for a PAT, `Bearer` for an Entra token) and may pass its own `fetch`, so it runs in the API, the
// extension and tests alike. Tokens never appear in errors.

const API = '7.1'
const BASE = 'https://dev.azure.com'
/** Azure DevOps caps a workitemsbatch call at 200 ids. */
const BATCH = 200

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  statusText: string
  text(): Promise<string>
}>

/** A failed Azure DevOps call; `status` lets callers tell "no access" (401/403) from "not found" (404). */
export class AdoRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AdoRequestError'
  }
}

/** `Authorization` header for a personal access token. */
export function patAuthHeader(pat: string): string {
  const raw = `:${pat}`
  const b64 = typeof btoa === 'function' ? btoa(raw) : (globalThis as { Buffer?: { from(s: string): { toString(enc: string): string } } }).Buffer!.from(raw).toString('base64')
  return `Basic ${b64}`
}

export interface AdoAccess {
  org: string
  project: string
  /** The full Authorization header value. */
  authorization: string
  fetch?: FetchLike
}

async function call<T>(access: Pick<AdoAccess, 'authorization' | 'fetch'>, url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const f = access.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const res = await f(url, {
    method: init?.method ?? 'GET',
    headers: { Authorization: access.authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = ''
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? ''
    } catch {
      /* not JSON (an HTML sign-in page for a bad token) */
    }
    throw new AdoRequestError(res.status, `Azure DevOps request failed (${res.status}): ${(message || res.statusText).slice(0, 300)}`)
  }
  // 203 (or a followed redirect) = Azure DevOps' sign-in page: the token was not accepted.
  if (res.status === 203) throw new AdoRequestError(203, 'Azure DevOps did not accept the token (it answered with its sign-in page).')
  const raw = await res.text()
  try {
    return (raw ? JSON.parse(raw) : {}) as T
  } catch {
    throw new AdoRequestError(203, 'Azure DevOps did not accept the token (it answered with its sign-in page).')
  }
}

const seg = (s: string) => encodeURIComponent(s)
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Pass as the identity to match the token's owner (WIQL `@Me`). */
export const ME = '@Me'

/** The default work item types synced as stories (whichever exist in the project's process). */
export const DEFAULT_SYNC_WORK_ITEM_TYPES = ['User Story', 'Product Backlog Item', 'Requirement', 'Bug', 'Task', 'Issue']

/**
 * WIQL for the work items assigned to `identity` (an email / UPN) in `project`, of the given types, newest change
 * first. Every value is quoted and escaped — identity and types come from user settings.
 */
export function buildAssignedToWiql(input: { project: string; identity: string; types: readonly string[]; areaPath?: string | null }): string {
  const types = input.types.length ? input.types : DEFAULT_SYNC_WORK_ITEM_TYPES
  return (
    'SELECT [System.Id] FROM WorkItems WHERE ' +
    [
      `[System.TeamProject] = ${quote(input.project)}`,
      // `@Me` (the token's owner) is a WIQL macro, not a value.
      `[System.AssignedTo] = ${input.identity === ME ? ME : quote(input.identity)}`,
      `[System.WorkItemType] IN (${types.map(quote).join(', ')})`,
      `[System.State] <> 'Removed'`,
      ...(input.areaPath ? [`[System.AreaPath] UNDER ${quote(input.areaPath)}`] : []),
    ].join(' AND ') +
    ' ORDER BY [System.ChangedDate] DESC'
  )
}

/** One assigned work item, trimmed to what a story needs. */
export interface AdoWorkItem {
  id: number
  title: string
  /** Plain text (from the HTML field). */
  description: string
  /** One entry per criterion (list items or lines of the HTML field). */
  acceptanceCriteria: string[]
  state: string
  type: string
  /** 1 (highest) – 4, or null when the process has no priority field. */
  priority: number | null
  tags: string[]
  /** ISO timestamp of the last change in Azure DevOps. */
  changedAt: string
  assignedTo: { uniqueName: string; displayName: string } | null
  /** Area path, e.g. `Product Hub\Synfra`. */
  areaPath: string
  /** Iteration path, e.g. `Product Hub\Sprint 12`. */
  iterationPath: string
  /** The parent work item's id, if any. */
  parentId: number | null
  /** The parent's id and title (null without a parent; the title is read in one extra batched call). */
  parent: { id: number; title: string } | null
  /** The work item in the Azure DevOps web UI. */
  url: string
}

const FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.Description',
  'System.Tags',
  'System.ChangedDate',
  'System.AssignedTo',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'Microsoft.VSTS.Common.Priority',
  'System.AreaPath',
  'System.IterationPath',
  'System.Parent',
  // Bugs keep their detail here (often with an empty System.Description).
  'Microsoft.VSTS.TCM.ReproSteps',
]

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" }

/** Azure DevOps rich-text HTML → readable plain text (paragraphs and list items become lines). */
export function htmlToText(html: unknown): string {
  if (typeof html !== 'string' || !html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Acceptance criteria HTML → one string per criterion (list items, else non-empty lines), at most 30. */
export function splitCriteria(html: unknown): string[] {
  return htmlToText(html)
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(0, 500))
    .slice(0, 30)
}

/**
 * A work item's description as plain text. Bugs usually describe the problem in Repro Steps instead: that is used
 * when the description is empty, and appended as a "Repro steps" section when both are set.
 */
export function workItemDescription(f: Record<string, unknown>): string {
  const description = htmlToText(f['System.Description'])
  const repro = htmlToText(f['Microsoft.VSTS.TCM.ReproSteps'])
  if (!repro) return description
  if (!description) return repro
  return `${description}\n\nRepro steps:\n${repro}`
}

function toWorkItem(access: Pick<AdoAccess, 'org' | 'project'>, id: number, f: Record<string, unknown>): AdoWorkItem {
  const assigned = f['System.AssignedTo'] as { uniqueName?: string; displayName?: string } | string | undefined
  const priority = Number(f['Microsoft.VSTS.Common.Priority'])
  return {
    id,
    title: String(f['System.Title'] ?? `Work item ${id}`).slice(0, 200),
    description: workItemDescription(f),
    acceptanceCriteria: splitCriteria(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
    state: String(f['System.State'] ?? ''),
    type: String(f['System.WorkItemType'] ?? ''),
    priority: Number.isInteger(priority) && priority > 0 ? priority : null,
    tags: String(f['System.Tags'] ?? '')
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean),
    changedAt: String(f['System.ChangedDate'] ?? new Date(0).toISOString()),
    assignedTo:
      assigned && typeof assigned === 'object'
        ? { uniqueName: assigned.uniqueName ?? '', displayName: assigned.displayName ?? assigned.uniqueName ?? '' }
        : typeof assigned === 'string' && assigned
          ? { uniqueName: assigned, displayName: assigned }
          : null,
    areaPath: String(f['System.AreaPath'] ?? ''),
    iterationPath: String(f['System.IterationPath'] ?? ''),
    parentId: Number.isInteger(Number(f['System.Parent'])) && Number(f['System.Parent']) > 0 ? Number(f['System.Parent']) : null,
    parent: null,
    url: `${BASE}/${seg(access.org)}/${seg(access.project)}/_workitems/edit/${id}`,
  }
}

/** The work items assigned to `identity` in the project (at most `max`, newest change first). */
export async function fetchAssignedWorkItems(
  access: AdoAccess,
  input: { identity: string; types: readonly string[]; areaPath?: string | null; max?: number },
): Promise<AdoWorkItem[]> {
  const query = buildAssignedToWiql({ project: access.project, identity: input.identity, types: input.types, areaPath: input.areaPath })
  const res = await call<{ workItems?: Array<{ id: number }> }>(
    access,
    `${BASE}/${seg(access.org)}/${seg(access.project)}/_apis/wit/wiql?$top=${input.max ?? 500}&api-version=${API}`,
    { method: 'POST', body: { query } },
  )
  const ids = (res.workItems ?? []).map((w) => w.id).slice(0, input.max ?? 500)
  const out: AdoWorkItem[] = []
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    const batch = await call<{ value?: Array<{ id: number; fields?: Record<string, unknown> }> }>(
      access,
      `${BASE}/${seg(access.org)}/${seg(access.project)}/_apis/wit/workitemsbatch?api-version=${API}`,
      { method: 'POST', body: { ids: chunk, fields: FIELDS, errorPolicy: 'omit' } },
    )
    const byId = new Map((batch.value ?? []).filter((v) => v && v.id).map((v) => [v.id, v]))
    for (const id of chunk) {
      const v = byId.get(id)
      if (v) out.push(toWorkItem(access, id, v.fields ?? {}))
    }
  }
  await attachParents(access, out)
  return out
}

// ─── Everything assigned to the token's owner, across the organization ─────────────────────────────

/** Org-wide access with the user's own token: `@Me` is the token's owner. */
export type AdoOrgAccess = Omit<AdoAccess, 'project'>

/** WIQL for every work item assigned to the token's owner (`@Me`) in any project of the organization, newest change first. */
export function buildMyWorkItemsWiql(): string {
  return "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC"
}

/** One of my work items, with the Azure DevOps project it lives in and its parent's title. */
export interface AdoMyWorkItem extends AdoWorkItem {
  project: string
}

/**
 * Every work item assigned to the token's owner across the organization (at most `max`, newest change first). Uses
 * the organization-level WIQL and batch endpoints, so it needs no project; each item's URL uses its own project.
 */
export async function fetchMyWorkItems(access: AdoOrgAccess, input: { max?: number } = {}): Promise<AdoMyWorkItem[]> {
  const max = input.max ?? 500
  const res = await call<{ workItems?: Array<{ id: number }> }>(access, `${BASE}/${seg(access.org)}/_apis/wit/wiql?$top=${max}&api-version=${API}`, {
    method: 'POST',
    body: { query: buildMyWorkItemsWiql() },
  })
  const ids = (res.workItems ?? []).map((w) => w.id).slice(0, max)
  const out: AdoMyWorkItem[] = []
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    const batch = await call<{ value?: Array<{ id: number; fields?: Record<string, unknown> }> }>(
      access,
      `${BASE}/${seg(access.org)}/_apis/wit/workitemsbatch?api-version=${API}`,
      { method: 'POST', body: { ids: chunk, fields: [...FIELDS, 'System.TeamProject'], errorPolicy: 'omit' } },
    )
    const byId = new Map((batch.value ?? []).filter((v) => v && v.id).map((v) => [v.id, v]))
    for (const id of chunk) {
      const fields = byId.get(id)?.fields
      if (!fields) continue
      const project = String(fields['System.TeamProject'] ?? '')
      out.push({ ...toWorkItem({ org: access.org, project }, id, fields), project, parent: null })
    }
  }
  await attachParents(access, out)
  return out
}

/**
 * Fill in each item's `parent`: titles from the items themselves, else one more organization-level batched read
 * (parents often aren't among the items). A parent that can't be read keeps a "Work item N" title.
 */
async function attachParents(access: AdoOrgAccess, items: AdoWorkItem[]): Promise<void> {
  const titles = new Map(items.map((i) => [i.id, i.title]))
  const missing = [...new Set(items.map((i) => i.parentId).filter((p): p is number => p !== null && !titles.has(p)))]
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = await call<{ value?: Array<{ id: number; fields?: Record<string, unknown> }> }>(
      access,
      `${BASE}/${seg(access.org)}/_apis/wit/workitemsbatch?api-version=${API}`,
      { method: 'POST', body: { ids: missing.slice(i, i + BATCH), fields: ['System.Id', 'System.Title'], errorPolicy: 'omit' } },
    ).catch(() => ({ value: [] }) as { value?: Array<{ id: number; fields?: Record<string, unknown> }> })
    for (const v of batch.value ?? []) if (v?.id) titles.set(v.id, String(v.fields?.['System.Title'] ?? `Work item ${v.id}`))
  }
  for (const item of items) {
    if (item.parentId !== null) item.parent = { id: item.parentId, title: titles.get(item.parentId) ?? `Work item ${item.parentId}` }
  }
}

/** Area paths of a project (the project's root first), e.g. `Product Hub`, `Product Hub\Synfra`. */
export async function fetchAreaPaths(access: AdoAccess): Promise<string[]> {
  type Node = { name: string; path?: string; children?: Node[] }
  const root = await call<Node>(access, `${BASE}/${seg(access.org)}/${seg(access.project)}/_apis/wit/classificationnodes/Areas?$depth=10&api-version=${API}`)
  const out: string[] = []
  const walk = (n: Node, parent: string | null): void => {
    const path = parent ? `${parent}\\${n.name}` : n.name
    out.push(path)
    for (const c of n.children ?? []) walk(c, path)
  }
  walk(root, null)
  return out
}

/** Azure DevOps state categories — the same five in every process (Agile, Scrum, CMMI, Basic, custom). */
export type AdoStateCategory = 'Proposed' | 'InProgress' | 'Resolved' | 'Completed' | 'Removed'

/** A work item type's states → their category (e.g. "Active" → InProgress, "Closed" → Completed). */
export async function fetchStateCategories(access: AdoAccess, type: string): Promise<Record<string, AdoStateCategory>> {
  const res = await call<{ value?: Array<{ name: string; category: string }> }>(
    access,
    `${BASE}/${seg(access.org)}/${seg(access.project)}/_apis/wit/workitemtypes/${seg(type)}/states?api-version=${API}`,
  )
  const out: Record<string, AdoStateCategory> = {}
  for (const s of res.value ?? []) out[s.name] = s.category as AdoStateCategory
  return out
}

/** Best guess at a state's category when the type's states can't be read (well-known names of the built-in processes). */
export function guessStateCategory(state: string): AdoStateCategory {
  const s = state.toLowerCase()
  if (['new', 'to do', 'proposed', 'approved', 'open'].includes(s)) return 'Proposed'
  if (['resolved', 'in review', 'testing'].includes(s)) return 'Resolved'
  if (['closed', 'done', 'completed'].includes(s)) return 'Completed'
  if (s === 'removed') return 'Removed'
  return 'InProgress'
}

/** Each work item's area path (organization-level batch reads; ids Azure DevOps no longer has are left out). */
export async function fetchWorkItemAreaPaths(access: AdoOrgAccess, ids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = await call<{ value?: Array<{ id: number; fields?: Record<string, unknown> }> }>(
      access,
      `${BASE}/${seg(access.org)}/_apis/wit/workitemsbatch?api-version=${API}`,
      { method: 'POST', body: { ids: ids.slice(i, i + BATCH), fields: ['System.Id', 'System.AreaPath'], errorPolicy: 'omit' } },
    )
    for (const v of batch.value ?? []) if (v?.id) out.set(v.id, String(v.fields?.['System.AreaPath'] ?? ''))
  }
  return out
}

/** Whether `path` is `area` or under it (Azure DevOps paths compare case-insensitively). */
export function isUnderArea(path: string, area: string): boolean {
  const p = path.toLowerCase()
  const a = area.toLowerCase()
  return p === a || p.startsWith(`${a}\\`)
}
