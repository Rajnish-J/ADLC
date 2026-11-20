// A project's repository and the org's Git connections. Tokens never pass through chat: connections are listed
// by name and owner only, and adding or replacing a token happens in Settings → Git connections.

import { z } from 'zod'
import { badRequest } from '../../http'
import { listConnections } from '../../repo/connections'
import * as repoService from '../../repo/service'
import { defineChatTool, projectOf, PROJECT_FIELD_DESCRIPTION, type ChatToolContext } from './kit'

const project = z.string().nullable().describe(PROJECT_FIELD_DESCRIPTION)

function manager(ctx: ChatToolContext) {
  if (!ctx.deps.repos) throw badRequest('Repository features are not available on this server.')
  return ctx.deps.repos
}

export const repoTools = [
  defineChatTool({
    name: 'get_repository',
    label: 'Read repository',
    access: 'read',
    description: "The project's linked repository (or blank workspace): URL, provider, default branch, sync status and last error.",
    input: z.object({ project }),
    execute: async (ctx, { project: key }) => {
      const r = await repoService.getRepository(ctx.deps.db, ctx.caller.user, projectOf(ctx, key))
      return r ?? { linked: false }
    },
  }),
  defineChatTool({
    name: 'list_branches',
    label: 'List branches',
    access: 'read',
    description: "The repository's branches and whether each is indexed.",
    input: z.object({ project }),
    execute: async (ctx, { project: key }) => repoService.listBranches(ctx.deps.db, ctx.caller.user, projectOf(ctx, key)),
  }),
  defineChatTool({
    name: 'list_syncs',
    label: 'Sync history',
    access: 'read',
    description: 'Recent repository syncs: when, why, status, errors and file counts.',
    input: z.object({ project }),
    execute: async (ctx, { project: key }) => (await repoService.listSyncs(ctx.deps.db, ctx.caller.user, projectOf(ctx, key))).slice(0, 15),
  }),
  defineChatTool({
    name: 'list_git_connections',
    label: 'List Git connections',
    access: 'read',
    permission: 'project.create',
    description:
      "The organization's Git connections (org admins): id, provider, name, the owner/organization each covers, the account and how many repositories use it. Tokens are never shown.",
    input: z.object({}),
    execute: async (ctx) =>
      (await listConnections(ctx.deps.db, ctx.caller.user)).map((c) => ({
        id: c.id,
        provider: c.provider,
        name: c.name,
        owner: c.owner ?? '(every GitHub owner)',
        account: c.account,
        repositories: c.repositories,
        verifiedAt: c.verifiedAt,
      })),
  }),
  defineChatTool({
    name: 'test_repository_url',
    label: 'Test repository access',
    access: 'read',
    permission: 'repo.manage',
    description: 'Check that the platform can reach a repository URL with the Git connections it has (before linking it).',
    input: z.object({ project, url: z.string().max(500) }),
    execute: async (ctx, { project: key, url }) => repoService.testProjectConnection(manager(ctx).rt, ctx.caller, projectOf(ctx, key), { url }),
  }),
  defineChatTool({
    name: 'link_repository',
    label: 'Link repository',
    access: 'write',
    permission: 'repo.manage',
    description: "Link (or change) the project's GitHub / Azure Repos repository. The platform clones it in the background. Not for blank-workspace projects.",
    input: z.object({ project, url: z.string().max(500), defaultBranch: z.string().max(250).nullable() }),
    execute: async (ctx, { project: key, url, defaultBranch }) => {
      const r = await repoService.saveRepository(manager(ctx), ctx.caller, projectOf(ctx, key), { url, defaultBranch })
      return { ok: true, repository: r }
    },
  }),
  defineChatTool({
    name: 'sync_repository',
    label: 'Sync repository',
    access: 'write',
    permission: 'code.edit',
    description: 'Fetch the latest from the remote and re-index the default branch (also re-imports repo agents and skills).',
    input: z.object({ project }),
    execute: async (ctx, { project: key }) => ({ ok: true, sync: await repoService.requestSync(manager(ctx), ctx.caller, projectOf(ctx, key)) }),
  }),
]
