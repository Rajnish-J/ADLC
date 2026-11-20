// Azure DevOps Boards work-item client.
//
// A thin REST client used by the issue-trigger flow: it runs a WIQL query for the work items
// assigned to the signed-in user (@Me), then batch-fetches their fields. Pure HTTP + Bearer, no
// SDK — callers inject the bearer token (azureAuth.getToken(ADO_SCOPE)). Tokens are redacted from
// error output, matching foundryClient's azureFetch.
//
// Framework-free except for the `fetch` global (available in the extension host), so the request
// shaping stays unit-testable with a stubbed fetch.

const ADO_API_VERSION = '7.1'
/** Comments live on a preview route distinct from the stable work-item API. */
const ADO_COMMENTS_API_VERSION = '7.1-preview.4'
export const DEFAULT_WORK_ITEM_TYPE = 'User Story'

/** A backlog work item, trimmed to what the trigger flow needs to seed a run. */
export interface WorkItem {
  id: number
  title: string
  description: string
  acceptanceCriteria: string
  state: string
  type: string
  /** Human-facing URL to the work item in the ADO web UI. */
  url: string
}

export interface FetchAssignedArgs {
  org: string
  project: string
  token: string
  /** Work-item type filter; defaults to "User Story". */
  workItemType?: string
  /** Optional WIQL override; when set, replaces the assigned-to-@Me default. */
  wiql?: string
  /** Cap on items fetched (the WIQL result is sliced before the batch GET). */
  max?: number
}

async function adoFetch<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const sanitised = text.replace(/(eyJ[\w-]{20,})/g, '<token-redacted>')
    throw new Error(
      `Azure DevOps request failed (${res.status}): ${sanitised.slice(0, 500) || res.statusText}`,
    )
  }
  const raw = await res.text()
  return (raw ? JSON.parse(raw) : {}) as T
}

const HTML_TAG = /<[^>]+>/g

/** ADO returns HTML for Description / Acceptance Criteria; strip tags to a readable plain string. */
function htmlToText(html: unknown): string {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(HTML_TAG, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Build the default WIQL: this user's assigned work items of `type`, newest first. */
export function buildAssignedWiql(workItemType: string): string {
  // [System.AssignedTo] = @Me resolves server-side to the authenticated identity.
  return (
    `SELECT [System.Id] FROM WorkItems ` +
    `WHERE [System.AssignedTo] = @Me AND [System.WorkItemType] = '${workItemType.replace(/'/g, "''")}' ` +
    `ORDER BY [System.ChangedDate] DESC`
  )
}

const ADO_ORG_BASE = 'https://dev.azure.com'

/**
 * Fetch the work items assigned to the signed-in user. Returns [] when nothing is assigned.
 * Two calls: POST the WIQL to get ids, then a batch GET for the fields we render.
 */
export async function fetchAssignedWorkItems(args: FetchAssignedArgs): Promise<WorkItem[]> {
  const { org, project, token } = args
  const workItemType = args.workItemType?.trim() || DEFAULT_WORK_ITEM_TYPE
  const max = args.max ?? 50
  const o = encodeURIComponent(org)
  const p = encodeURIComponent(project)

  const wiql = args.wiql?.trim() || buildAssignedWiql(workItemType)
  type WiqlResp = { workItems?: Array<{ id: number }> }
  const wiqlResp = await adoFetch<WiqlResp>(
    `${ADO_ORG_BASE}/${o}/${p}/_apis/wit/wiql?api-version=${ADO_API_VERSION}`,
    token,
    { method: 'POST', body: JSON.stringify({ query: wiql }) },
  )

  const ids = (wiqlResp.workItems ?? []).map((w) => w.id).slice(0, max)
  if (ids.length === 0) return []
  return fetchWorkItemsByIds({ org, project, token, ids })
}

/** Fields requested for the work-item batch/single GETs; the trimmed set our renderers use. */
const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.Description',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
]

/** Map an ADO `fields` bag onto our trimmed WorkItem shape. */
function toWorkItem(org: string, project: string, id: number, fields: Record<string, unknown>, fallbackType?: string): WorkItem {
  const o = encodeURIComponent(org)
  const p = encodeURIComponent(project)
  return {
    id,
    title: String(fields['System.Title'] ?? `Work item ${id}`),
    description: htmlToText(fields['System.Description']),
    acceptanceCriteria: htmlToText(fields['Microsoft.VSTS.Common.AcceptanceCriteria']),
    state: String(fields['System.State'] ?? ''),
    type: String(fields['System.WorkItemType'] ?? fallbackType ?? ''),
    url: `${ADO_ORG_BASE}/${o}/${p}/_workitems/edit/${id}`,
  }
}

/** Batch-fetch work items by id, preserving the input order. Shared by the assigned + WIQL queries. */
async function fetchWorkItemsByIds(args: { org: string; project: string; token: string; ids: number[] }): Promise<WorkItem[]> {
  const { org, project, token, ids } = args
  if (ids.length === 0) return []
  const o = encodeURIComponent(org)
  const p = encodeURIComponent(project)
  type BatchResp = { value?: Array<{ id: number; fields?: Record<string, unknown> }> }
  const batch = await adoFetch<BatchResp>(
    `${ADO_ORG_BASE}/${o}/${p}/_apis/wit/workitemsbatch?api-version=${ADO_API_VERSION}`,
    token,
    { method: 'POST', body: JSON.stringify({ ids, fields: WORK_ITEM_FIELDS }) },
  )
  const byId = new Map<number, WorkItem>()
  for (const item of batch.value ?? []) byId.set(item.id, toWorkItem(org, project, item.id, item.fields ?? {}))
  return ids.map((id) => byId.get(id)).filter((w): w is WorkItem => Boolean(w))
}

export interface WorkItemRef {
  org: string
  project: string
  token: string
  id: number
}

/** Fetch a single work item by id. Throws if the id does not exist / isn't accessible. */
export async function getWorkItem(args: WorkItemRef): Promise<WorkItem> {
  const { org, project, token, id } = args
  const o = encodeURIComponent(org)
  const p = encodeURIComponent(project)
  const fieldsParam = encodeURIComponent(WORK_ITEM_FIELDS.join(','))
  type Resp = { id: number; fields?: Record<string, unknown> }
  const resp = await adoFetch<Resp>(
    `${ADO_ORG_BASE}/${o}/${p}/_apis/wit/workitems/${id}?fields=${fieldsParam}&api-version=${ADO_API_VERSION}`,
    token,
  )
  return toWorkItem(org, project, resp.id ?? id, resp.fields ?? {})
}

export interface QueryWorkItemsArgs {
  org: string
  project: string
  token: string
  /** Raw WIQL. When omitted, `state`/`workItemType`/`assignedToMe` build a default query. */
  wiql?: string
  state?: string
  workItemType?: string
  /** Restrict to items assigned to the signed-in user (@Me). */
  assignedToMe?: boolean
  max?: number
}

/** Query work items via WIQL (raw or built from simple filters), then batch-fetch their fields. */
export async function queryWorkItems(args: QueryWorkItemsArgs): Promise<WorkItem[]> {
  const { org, project, token } = args
  const max = args.max ?? 50
  const o = encodeURIComponent(org)
  const p = encodeURIComponent(project)
  const wiql = args.wiql?.trim() || buildFilteredWiql(args)
  type WiqlResp = { workItems?: Array<{ id: number }> }
  const wiqlResp = await adoFetch<WiqlResp>(
    `${ADO_ORG_BASE}/${o}/${p}/_apis/wit/wiql?api-version=${ADO_API_VERSION}`,
    token,
    { method: 'POST', body: JSON.stringify({ query: wiql }) },
  )
  const ids = (wiqlResp.workItems ?? []).map((w) => w.id).slice(0, max)
  return fetchWorkItemsByIds({ org, project, token, ids })
}

/** Build a WIQL query from simple filters. Values are single-quote-escaped to avoid breaking the query. */
function buildFilteredWiql(args: QueryWorkItemsArgs): string {
  const esc = (s: string) => s.replace(/'/g, "''")
  const clauses: string[] = []
  if (args.assignedToMe) clauses.push('[System.AssignedTo] = @Me')
  if (args.workItemType) clauses.push(`[System.WorkItemType] = '${esc(args.workItemType)}'`)
  if (args.state) clauses.push(`[System.State] = '${esc(args.state)}'`)
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  return `SELECT [System.Id] FROM WorkItems${where} ORDER BY [System.ChangedDate] DESC`
}

/** Friendly field name → ADO reference name for the fields agents are allowed to update. */
const UPDATABLE_FIELDS: Record<string, string> = {
  state: 'System.State',
  title: 'System.Title',
  description: 'System.Description',
  acceptanceCriteria: 'Microsoft.VSTS.Common.AcceptanceCriteria',
  priority: 'Microsoft.VSTS.Common.Priority',
  storyPoints: 'Microsoft.VSTS.Scheduling.StoryPoints',
  tags: 'System.Tags',
}

export interface UpdateWorkItemArgs extends WorkItemRef {
  /** Friendly field names (keys of UPDATABLE_FIELDS) → new values. Unknown keys are rejected. */
  fields: Record<string, unknown>
}

/** Patch fields on a work item via JSON-PATCH. Returns the refreshed item. */
export async function updateWorkItem(args: UpdateWorkItemArgs): Promise<WorkItem> {
  const { org, project, token, id, fields } = args
  const o = encodeURIComponent(org)
  const p = encodeURIComponent(project)
  const ops: Array<{ op: string; path: string; value: unknown }> = []
  for (const [key, value] of Object.entries(fields)) {
    const ref = UPDATABLE_FIELDS[key]
    if (!ref) throw new Error(`Field "${key}" is not updatable. Allowed: ${Object.keys(UPDATABLE_FIELDS).join(', ')}.`)
    ops.push({ op: 'add', path: `/fields/${ref}`, value })
  }
  if (ops.length === 0) throw new Error('No updatable fields supplied.')
  type Resp = { id: number; fields?: Record<string, unknown> }
  const resp = await adoFetch<Resp>(
    `${ADO_ORG_BASE}/${o}/${p}/_apis/wit/workitems/${id}?api-version=${ADO_API_VERSION}`,
    token,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json-patch+json' }, body: JSON.stringify(ops) },
  )
  return toWorkItem(org, project, resp.id ?? id, resp.fields ?? {})
}

export interface AddCommentArgs extends WorkItemRef {
  /** Comment body. May contain HTML for rich formatting. */
  text: string
}

/** Post a discussion comment to a work item. Returns the new comment id. */
export async function addWorkItemComment(args: AddCommentArgs): Promise<{ id: number }> {
  const { org, project, token, id, text } = args
  const o = encodeURIComponent(org)
  const p = encodeURIComponent(project)
  type Resp = { id?: number }
  const resp = await adoFetch<Resp>(
    `${ADO_ORG_BASE}/${o}/${p}/_apis/wit/workItems/${id}/comments?api-version=${ADO_COMMENTS_API_VERSION}`,
    token,
    { method: 'POST', body: JSON.stringify({ text }) },
  )
  return { id: resp.id ?? 0 }
}

export interface CreatePullRequestArgs {
  org: string
  project: string
  token: string
  /** Repository name (ADO's Git PR API accepts a name here, avoiding an extra id lookup). */
  repository: string
  sourceBranch: string
  targetBranch: string
  title: string
  description?: string
  isDraft?: boolean
  /** Work item id(s) to link on the PR, e.g. the run's seeded work item. */
  workItemIds?: number[]
}

export interface PullRequest {
  id: number
  /** Human-facing URL to the PR in the ADO web UI (the REST response's own `url` is the API URL). */
  url: string
}

/** Open a Pull Request from `sourceBranch` into `targetBranch`, optionally linking work items. */
export async function createPullRequest(args: CreatePullRequestArgs): Promise<PullRequest> {
  const { org, project, token, repository } = args
  const o = encodeURIComponent(org)
  const p = encodeURIComponent(project)
  const r = encodeURIComponent(repository)
  type Resp = { pullRequestId?: number }
  const resp = await adoFetch<Resp>(
    `${ADO_ORG_BASE}/${o}/${p}/_apis/git/repositories/${r}/pullrequests?api-version=${ADO_API_VERSION}`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        sourceRefName: `refs/heads/${args.sourceBranch}`,
        targetRefName: `refs/heads/${args.targetBranch}`,
        title: args.title,
        description: args.description ?? '',
        isDraft: args.isDraft ?? true,
        workItemRefs: (args.workItemIds ?? []).map((id) => ({ id: String(id) })),
      }),
    },
  )
  const id = resp.pullRequestId ?? 0
  return { id, url: `${ADO_ORG_BASE}/${o}/${p}/_git/${r}/pullrequest/${id}` }
}

/** Render a work item into the seed prompt handed to the first agent in the workflow. */
export function workItemToTaskPrompt(wi: WorkItem): string {
  const parts = [`# ${wi.type} #${wi.id}: ${wi.title}`]
  if (wi.description) parts.push(`\n## Description\n${wi.description}`)
  if (wi.acceptanceCriteria) parts.push(`\n## Acceptance Criteria\n${wi.acceptanceCriteria}`)
  parts.push(`\n(Source: ${wi.url})`)
  return parts.join('\n')
}
