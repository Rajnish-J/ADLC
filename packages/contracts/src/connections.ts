// Git connections: the organisation's access tokens for GitHub and Azure Repos, set up once by an org admin on the
// Git connections page. When the platform clones, syncs or commits a project's repository it picks the matching
// connection itself, so creating a project only needs the repository URL.

import { z } from 'zod'

export const GIT_CONNECTION_PROVIDERS = ['github', 'azure-repos'] as const
export type GitConnectionProvider = (typeof GIT_CONNECTION_PROVIDERS)[number]

/** A GitHub owner (user or org) or an Azure DevOps organisation: letters, digits, - _ . */
const OwnerSchema = z
  .string()
  .trim()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Use the owner or organization name as it appears in the URL (letters, digits, - _ .).')

const optionalOwner = z
  .union([OwnerSchema, z.literal('')])
  .optional()
  .transform((v) => (v ? v : undefined))

export const GitConnectionSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(GIT_CONNECTION_PROVIDERS),
  name: z.string(),
  /** The GitHub owner or Azure DevOps organization it covers; null = every GitHub owner. */
  owner: z.string().nullable(),
  /** Last 4 characters of the token. The token itself is never returned. */
  tokenHint: z.string(),
  /** The account the token belongs to, as the provider reported it when the token was verified. */
  account: z.string().nullable(),
  verifiedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** Linked repositories this connection is used for. */
  repositories: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GitConnection = z.infer<typeof GitConnectionSchema>

export const CreateGitConnectionInputSchema = z
  .object({
    provider: z.enum(GIT_CONNECTION_PROVIDERS),
    /** GitHub: optional (empty = all owners). Azure Repos: the organization, required. */
    owner: optionalOwner,
    name: z.string().trim().max(80).optional(),
    token: z.string().trim().min(1, 'Paste the access token.').max(500),
  })
  .refine((v) => v.provider !== 'azure-repos' || Boolean(v.owner), {
    message: 'Enter the Azure DevOps organization the token belongs to.',
    path: ['owner'],
  })
export type CreateGitConnectionInput = z.input<typeof CreateGitConnectionInputSchema>

export const UpdateGitConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** A new token (verified before it replaces the old one). */
  token: z.string().trim().min(1).max(500).optional(),
})
export type UpdateGitConnectionInput = z.infer<typeof UpdateGitConnectionInputSchema>

/** What a token check found: the account it belongs to. */
export const GitConnectionTestResultSchema = z.object({ account: z.string() })
export type GitConnectionTestResult = z.infer<typeof GitConnectionTestResultSchema>

/** A repository a Git connection's token can reach — for picking one to import. */
export const AccessibleRepoSchema = z.object({
  connectionId: z.string().uuid(),
  connectionName: z.string(),
  provider: z.enum(GIT_CONNECTION_PROVIDERS),
  /** Repository name alone (becomes the project name on import). */
  name: z.string(),
  /** `owner/repo` (GitHub) or `org/project/repo` (Azure DevOps). */
  fullName: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
  defaultBranch: z.string().nullable(),
  /** URL to link (accepted by parseRepoUrl). */
  url: z.string(),
  updatedAt: z.string().nullable(),
})
export type AccessibleRepo = z.infer<typeof AccessibleRepoSchema>

export const AccessibleReposSchema = z.object({
  repos: z.array(AccessibleRepoSchema),
  /** The token reaches more repositories than were listed. */
  truncated: z.boolean(),
})
export type AccessibleRepos = z.infer<typeof AccessibleReposSchema>

/** How the platform authenticates to a repository: a Git connection, a token stored on the project itself (older
 * repositories), or nothing (public repositories). */
export const RepoCredentialSchema = z.object({
  source: z.enum(['connection', 'project', 'none']),
  connectionId: z.string().nullable(),
  connectionName: z.string().nullable(),
})
export type RepoCredential = z.infer<typeof RepoCredentialSchema>

/**
 * The connection to use for a repository: one for its exact owner/organization, else (GitHub only) one that covers
 * every owner. Owners compare case-insensitively, as both hosts do. When several connections fit equally (an
 * organization can hold several tokens), the most recently verified one wins — a new or replaced token takes over.
 */
export function pickConnection<C extends { provider: string; owner: string | null; verifiedAt?: Date | string | null }>(
  connections: C[],
  provider: string,
  owner: string,
): C | null {
  const key = owner.toLowerCase()
  const time = (c: C): number => (c.verifiedAt ? new Date(c.verifiedAt).getTime() : 0)
  const newest = (cs: C[]): C | null => cs.reduce<C | null>((best, c) => (!best || time(c) > time(best) ? c : best), null)
  const same = connections.filter((c) => c.provider === provider)
  return newest(same.filter((c) => c.owner !== null && c.owner.toLowerCase() === key)) ?? newest(same.filter((c) => c.owner === null))
}

/** Where to create a token, with the scopes the platform needs. */
export const GIT_TOKEN_HELP: Record<GitConnectionProvider, { url: (owner?: string) => string; scopes: string }> = {
  github: {
    url: () => 'https://github.com/settings/personal-access-tokens/new',
    scopes: 'Fine-grained token with Repository permissions → Contents: Read and write (Metadata: Read is added automatically).',
  },
  'azure-repos': {
    url: (owner) => `https://dev.azure.com/${owner ? encodeURIComponent(owner) : '{organization}'}/_usersSettings/tokens`,
    scopes: 'Scopes: Code → Read & write. Add Work Items → Read to see your work items.',
  },
}
