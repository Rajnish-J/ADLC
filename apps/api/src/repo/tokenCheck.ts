// Talk to the Git providers' APIs with a connection's token: check it before it is saved (and learn which account
// it belongs to), list the repositories it reaches (import), and create a GitHub repository (publish a workspace).
// GitHub: GET api.github.com/user. Azure DevOps: GET dev.azure.com/<organization>/_apis/connectionData.
// The token is sent only to the provider it is for.

import { z } from 'zod'
import type { AccessibleRepo, GitConnectionProvider } from '@sdlc/contracts'
import { HttpError } from '../http'

const TIMEOUT_MS = 15_000

const GitHubUserSchema = z.object({ login: z.string() })
const AzureConnectionDataSchema = z.object({
  authenticatedUser: z
    .object({
      providerDisplayName: z.string().optional(),
      properties: z.object({ Account: z.object({ $value: z.string() }).partial().optional() }).partial().optional(),
    })
    .optional(),
})

const rejected = (message: string) => new HttpError(422, 'token_rejected', message)

async function call(url: string, headers: Record<string, string>, host: string): Promise<Response> {
  try {
    // redirect: 'manual' — Azure DevOps answers a bad PAT with a redirect to its sign-in page.
    return await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new HttpError(422, 'token_check_unreachable', `Could not reach ${host} to check the token. Check the API server's network access and try again.`)
  }
}

/** Verify `token` and return the account it belongs to; a 422 explains what's wrong otherwise. */
export async function verifyToken(provider: GitConnectionProvider, owner: string | undefined, token: string): Promise<string> {
  if (provider === 'github') {
    const res = await call(
      'https://api.github.com/user',
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub requires a User-Agent; a generic client name is enough.
        'User-Agent': 'sdlc-platform',
      },
      'api.github.com',
    )
    if (res.status === 401) throw rejected('GitHub rejected the token. Check that it was copied completely and hasn’t expired.')
    if (!res.ok) throw new HttpError(422, 'token_check_failed', `GitHub answered ${res.status} when checking the token.`)
    const body = GitHubUserSchema.safeParse(await res.json().catch(() => null))
    return body.success ? body.data.login : 'GitHub account'
  }

  if (!owner) throw new HttpError(400, 'bad_request', 'Enter the Azure DevOps organization the token belongs to.')
  const res = await call(
    `https://dev.azure.com/${encodeURIComponent(owner)}/_apis/connectionData`,
    { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`, Accept: 'application/json' },
    'dev.azure.com',
  )
  if (res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400)) {
    throw rejected(`Azure DevOps rejected the token for the “${owner}” organization. Check the token, its expiry and that it was created for this organization.`)
  }
  if (res.status === 404) throw new HttpError(422, 'token_check_failed', `There is no Azure DevOps organization called “${owner}”.`)
  if (!res.ok) throw new HttpError(422, 'token_check_failed', `Azure DevOps answered ${res.status} when checking the token.`)
  const body = AzureConnectionDataSchema.safeParse(await res.json().catch(() => null))
  const user = body.success ? body.data.authenticatedUser : undefined
  return user?.properties?.Account?.$value ?? user?.providerDisplayName ?? owner
}

// ─── Listing what a token reaches, and creating a repository (import / publish) ──────────────────

const GITHUB_PAGE = 100
const GITHUB_MAX_PAGES = 10

type ListedRepo = Omit<AccessibleRepo, 'connectionId' | 'connectionName' | 'provider'>

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sdlc-platform',
  }
}

const GitHubRepoSchema = z.object({
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable().optional(),
  private: z.boolean(),
  default_branch: z.string().nullable().optional(),
  html_url: z.string(),
  updated_at: z.string().nullable().optional(),
  pushed_at: z.string().nullable().optional(),
  owner: z.object({ login: z.string() }),
  archived: z.boolean().optional(),
})

const AzureReposSchema = z.object({
  value: z.array(
    z.object({
      name: z.string(),
      webUrl: z.string().optional(),
      defaultBranch: z.string().optional(),
      isDisabled: z.boolean().optional(),
      project: z.object({ name: z.string(), visibility: z.string().optional(), lastUpdateTime: z.string().optional() }),
    }),
  ),
})

/**
 * Every repository the token can reach. GitHub: the token's own, its collaborations and its organisations', most
 * recently pushed first, up to 1000 (not narrowed to the connection's owner: an imported repository keeps the
 * connection it was picked from, so it is cloned with this token whoever owns it). Azure DevOps: every repository
 * of the connection's organization.
 */
export async function listAccessibleRepos(
  provider: GitConnectionProvider,
  owner: string | null,
  token: string,
): Promise<{ repos: ListedRepo[]; truncated: boolean }> {
  if (provider === 'github') {
    const repos: ListedRepo[] = []
    let truncated = false
    for (let page = 1; page <= GITHUB_MAX_PAGES; page++) {
      const res = await call(
        `https://api.github.com/user/repos?per_page=${GITHUB_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        githubHeaders(token),
        'api.github.com',
      )
      if (res.status === 401) throw rejected('GitHub rejected this connection’s token. An org admin can replace it in Settings → Git connections.')
      if (!res.ok) throw new HttpError(502, 'provider_error', `GitHub answered ${res.status} when listing repositories.`)
      const body = z.array(GitHubRepoSchema).safeParse(await res.json().catch(() => null))
      if (!body.success) throw new HttpError(502, 'provider_error', 'GitHub sent a repository list the platform could not read.')
      for (const r of body.data) {
        if (r.archived) continue
        repos.push({
          name: r.name,
          fullName: r.full_name,
          description: r.description ?? null,
          private: r.private,
          defaultBranch: r.default_branch ?? null,
          url: r.html_url,
          updatedAt: r.pushed_at ?? r.updated_at ?? null,
        })
      }
      if (body.data.length < GITHUB_PAGE) break
      if (page === GITHUB_MAX_PAGES) truncated = true
    }
    return { repos, truncated }
  }

  if (!owner) return { repos: [], truncated: false }
  const res = await call(
    `https://dev.azure.com/${encodeURIComponent(owner)}/_apis/git/repositories?api-version=7.1`,
    { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`, Accept: 'application/json' },
    'dev.azure.com',
  )
  if (res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400)) {
    throw rejected(`Azure DevOps rejected this connection’s token for “${owner}”. An org admin can replace it in Settings → Git connections.`)
  }
  if (!res.ok) throw new HttpError(502, 'provider_error', `Azure DevOps answered ${res.status} when listing repositories.`)
  const body = AzureReposSchema.safeParse(await res.json().catch(() => null))
  if (!body.success) throw new HttpError(502, 'provider_error', 'Azure DevOps sent a repository list the platform could not read.')
  const repos = body.data.value
    .filter((r) => !r.isDisabled)
    .map(
      (r): ListedRepo => ({
        name: r.name,
        fullName: `${owner}/${r.project.name}/${r.name}`,
        description: null,
        private: r.project.visibility !== 'public',
        defaultBranch: r.defaultBranch ? r.defaultBranch.replace(/^refs\/heads\//, '') : null,
        url: r.webUrl ?? `https://dev.azure.com/${encodeURIComponent(owner)}/${encodeURIComponent(r.project.name)}/_git/${encodeURIComponent(r.name)}`,
        updatedAt: r.project.lastUpdateTime ?? null,
      }),
    )
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
  return { repos, truncated: false }
}

/**
 * Create an empty GitHub repository under the token's own account (`owner` omitted or equal to it) or under an
 * organisation. Returns its owner, name and web URL.
 */
export async function createGitHubRepo(
  token: string,
  input: { owner?: string; account: string | null; name: string; private: boolean; description?: string },
): Promise<{ owner: string; name: string; htmlUrl: string }> {
  const own = !input.owner || (input.account !== null && input.owner.toLowerCase() === input.account.toLowerCase())
  const url = own ? 'https://api.github.com/user/repos' : `https://api.github.com/orgs/${encodeURIComponent(input.owner ?? '')}/repos`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: input.name, private: input.private, description: input.description ?? '', auto_init: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new HttpError(502, 'provider_unreachable', 'Could not reach GitHub to create the repository.')
  }
  const body = (await res.json().catch(() => null)) as { message?: string; errors?: Array<{ message?: string }> } | null
  if (res.status === 401) throw rejected('GitHub rejected the connection’s token.')
  if (res.status === 403 || res.status === 404) {
    throw new HttpError(
      403,
      'publish_forbidden',
      `The token can’t create repositories${own ? '' : ` in ${input.owner}`}. It needs Administration: Read and write (fine-grained token) or the repo scope (classic token).`,
    )
  }
  if (res.status === 422) {
    const detail = body?.errors?.[0]?.message ?? body?.message ?? 'GitHub refused the name.'
    throw new HttpError(409, 'repo_exists', /already exists/i.test(detail) ? `A repository called ${input.name} already exists there.` : detail)
  }
  if (!res.ok) throw new HttpError(502, 'provider_error', `GitHub answered ${res.status} when creating the repository.`)
  const created = z.object({ name: z.string(), html_url: z.string(), owner: z.object({ login: z.string() }) }).safeParse(body)
  if (!created.success) throw new HttpError(502, 'provider_error', 'GitHub created the repository but sent an unexpected answer.')
  return { owner: created.data.owner.login, name: created.data.name, htmlUrl: created.data.html_url }
}
