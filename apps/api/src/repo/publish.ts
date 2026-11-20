// Publish a workspace to GitHub: create an empty repository with one of the organisation's Git connections, push
// the workspace's files to it as one commit on `main`, and turn the project's repository row into an ordinary
// linked GitHub repository (which then syncs like any other — the blob ids already match, so drafts carry over).

import { join } from 'path'
import { eq } from 'drizzle-orm'
import { parseRepoUrl, type ProjectRepository, type PublishWorkspaceInput } from '@sdlc/contracts'
import { assertCan, loadProjectAccess } from '../access'
import { writeAudit } from '../audit'
import { projectRepositories, projects } from '../db/schema'
import { badRequest, HttpError } from '../http'
import type { Caller } from '../services/context'
import { connectionById, connectionToken } from './connections'
import { GitError, gitText, runGit } from './git'
import type { RepoManager } from './jobs'
import { requireGit, withTempDir } from './runtime'
import { repoOf, toRepository } from './service'
import { createGitHubRepo } from './tokenCheck'
import { isWorkspace, WORKSPACE_BRANCH, workspaceBranch, workspaceSnapshot } from './workspace'

export async function publishWorkspace(
  manager: RepoManager,
  caller: Caller,
  key: string,
  input: Omit<PublishWorkspaceInput, 'private'> & { private: boolean },
): Promise<ProjectRepository> {
  const { rt } = manager
  const { db } = rt
  requireGit(rt)
  const access = await loadProjectAccess(db, caller.user, key)
  assertCan(access, 'repo.manage')
  const repo = await repoOf(db, access.project.id)
  if (!repo || !isWorkspace(repo)) throw new HttpError(409, 'not_a_workspace', 'Only a workspace can be published — this project already has a repository.')

  const connection = await connectionById(db, caller.user.orgId, input.connectionId)
  if (connection.provider !== 'github') throw badRequest('Pick a GitHub connection — workspaces are published to GitHub.')
  if (connection.owner && input.owner && connection.owner.toLowerCase() !== input.owner.toLowerCase()) {
    throw badRequest(`That connection only covers ${connection.owner}.`)
  }
  const token = connectionToken(rt, connection)

  const branch = await workspaceBranch(db, repo, WORKSPACE_BRANCH)
  const files = await workspaceSnapshot(db, repo, branch)
  if (files.length === 0) throw badRequest('The workspace is empty — add a file before publishing it.')

  const created = await createGitHubRepo(token, {
    owner: input.owner ?? connection.owner ?? undefined,
    account: connection.account,
    name: input.name,
    private: input.private,
    description: access.project.description ?? undefined,
  })
  const parsed = parseRepoUrl(created.htmlUrl)
  if (!parsed.ok) throw new HttpError(502, 'provider_error', 'GitHub created the repository at an unexpected address.')
  const remote = parsed.repo

  const auth = { provider: 'github' as const, token }
  await withTempDir(rt, 'publish', async (dir) => {
    await runGit(['init', '--bare', '-q', dir], { timeoutMs: 60_000 })
    const local = { cwd: dir, timeoutMs: 120_000, env: { GIT_INDEX_FILE: join(dir, 'sdlc-index') } }
    const indexInfo: string[] = []
    for (const f of files) {
      const sha = (await gitText(['hash-object', '-w', '--stdin'], { ...local, input: Buffer.from(f.content, 'utf8') })).trim()
      indexInfo.push(`${f.mode === '100755' ? '100755' : '100644'} ${sha}\t${f.path}`)
    }
    await runGit(['update-index', '--add', '-z', '--index-info'], { ...local, input: indexInfo.join('\0') + '\0' })
    const tree = (await gitText(['write-tree'], local)).trim()
    const identity = {
      GIT_AUTHOR_NAME: caller.user.displayName,
      GIT_AUTHOR_EMAIL: caller.user.email,
      GIT_COMMITTER_NAME: caller.user.displayName,
      GIT_COMMITTER_EMAIL: caller.user.email,
    }
    const commit = (await gitText(['commit-tree', tree, '-F', '-'], { ...local, env: { ...local.env, ...identity }, input: 'Initial commit from the SDLC platform workspace\n' })).trim()
    try {
      await runGit(['push', '--quiet', '--no-verify', remote.cloneUrl, `${commit}:refs/heads/${WORKSPACE_BRANCH}`], { cwd: dir, auth, timeoutMs: rt.gitTimeoutMs })
    } catch (err) {
      if (err instanceof GitError) {
        throw new HttpError(502, 'push_failed', `The repository ${remote.displayName} was created, but pushing the files failed: ${err.message}`)
      }
      throw err
    }
  })

  await db.transaction(async (tx) => {
    await tx
      .update(projectRepositories)
      .set({
        provider: 'github',
        remoteUrl: remote.cloneUrl,
        webUrl: remote.webUrl,
        displayName: remote.displayName,
        defaultBranch: WORKSPACE_BRANCH,
        defaultBranchPinned: false,
        connectionId: connection.id,
        status: 'queued',
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(projectRepositories.id, repo.id))
    await tx.update(projects).set({ repoUrl: remote.cloneUrl }).where(eq(projects.id, access.project.id))
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      projectId: access.project.id,
      actorUserId: caller.user.id,
      action: 'repo.published',
      resourceType: 'repository',
      resourceId: repo.id,
      data: { repository: remote.displayName, provider: 'github', connection: connection.name, private: input.private },
      via: caller.via,
    })
  })

  await manager.enqueue(repo.id, 'link', { requestedBy: caller.user.id, via: caller.via })
  rt.bus.publish({ type: 'project.changed', projectKey: access.project.key, action: 'repository', actorId: caller.user.id })
  const [fresh] = await db.select().from(projectRepositories).where(eq(projectRepositories.id, repo.id)).limit(1)
  return toRepository(db, fresh)
}
