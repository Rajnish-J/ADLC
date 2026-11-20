// Linked repository and code (/api/v1): link / test / sync / unlink a project's GitHub or Azure Repos repository,
// browse its branches, folders and files, keep per-member drafts and commit them. Branch names always travel as
// a query parameter (`?branch=feature/x`) because they contain slashes.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  BranchNameSchema,
  CommitInputSchema,
  CreateBranchInputSchema,
  CreateRepoFileInputSchema,
  DeleteRepoFileInputSchema,
  PublishWorkspaceInputSchema,
  GitShaSchema,
  RepoDirSchema,
  RepoPathSchema,
  RepoTestInputSchema,
  SaveDraftInputSchema,
  UpdateRepositoryInputSchema,
  can,
} from '@sdlc/contracts'
import { actorOf, assertCan, loadProjectAccess } from './access'
import { forbidden, parse } from './http'
import { HttpError } from './http'
import { commitDrafts, createBranch } from './repo/committer'
import type { RepoManager } from './repo/jobs'
import { publishWorkspace } from './repo/publish'
import { requireGit } from './repo/runtime'
import * as repoService from './repo/service'
import * as runBranches from './repo/runBranches'
import { createWorkspaceFile, deleteWorkspaceFile, isWorkspace } from './repo/workspace'
import { caller, KeyParams } from './routeKit'

const BranchQuery = z.object({ branch: BranchNameSchema.optional() })
const TreeQuery = BranchQuery.extend({ path: RepoDirSchema.optional().default('') })
const FileQuery = BranchQuery.extend({ path: RepoPathSchema })
const DraftQuery = z.object({ branch: BranchNameSchema, path: RepoPathSchema })
const BlobParams = KeyParams.extend({ sha: GitShaSchema })
const IndexQuery = z.object({ branch: BranchNameSchema })

const DRAFT_BODY_LIMIT = 2 * 1024 * 1024
const RunBranchParams = KeyParams.extend({ runId: z.string().uuid() })
const RunTreeQuery = z.object({ path: RepoDirSchema.optional().default('') })
const RunFileQuery = z.object({ path: z.string().min(1).max(1000) })

export function registerRepoRoutes(app: FastifyInstance, repos: RepoManager): void {
  const { db } = repos.rt

  // ─── Connection ────────────────────────────────────────────────────────────────────────────────

  /** Test a URL + token before a project exists (the create-project dialog). Org admins only, like creating. */
  app.post('/api/v1/repositories/test', async (req) => {
    if (!can(actorOf(req.user), undefined, 'project.create')) throw forbidden('Only an org admin can create projects.')
    return repoService.testConnection(repos.rt, req.user, parse(RepoTestInputSchema, req.body))
  })

  app.post('/api/v1/projects/:key/repository/test', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return repoService.testProjectConnection(repos.rt, caller(req), key, parse(RepoTestInputSchema, req.body))
  })

  app.get('/api/v1/projects/:key/repository', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return repoService.getRepository(db, req.user, key)
  })

  app.put('/api/v1/projects/:key/repository', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return repoService.saveRepository(repos, caller(req), key, parse(UpdateRepositoryInputSchema, req.body))
  })

  app.delete('/api/v1/projects/:key/repository', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    await repoService.unlinkRepository(repos, caller(req), key)
    return reply.code(204).send()
  })

  /** Publish a workspace to a new GitHub repository (with one of the organisation's Git connections). */
  app.post('/api/v1/projects/:key/repository/publish', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return publishWorkspace(repos, caller(req), key, parse(PublishWorkspaceInputSchema, req.body))
  })

  app.post('/api/v1/projects/:key/repository/sync', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    reply.code(202)
    return repoService.requestSync(repos, caller(req), key)
  })

  app.get('/api/v1/projects/:key/repository/syncs', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return repoService.listSyncs(db, req.user, key)
  })

  // ─── Branches ──────────────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:key/code/branches', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return repoService.listBranches(db, req.user, key)
  })

  /** Load a branch's files. 202 with the sync, or 200 with null when it is already up to date. */
  app.post('/api/v1/projects/:key/code/branches/index', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    const { branch } = parse(IndexQuery, req.query)
    const sync = await repoService.requestBranchIndex(repos, caller(req), key, branch)
    if (sync) reply.code(202)
    return sync
  })

  app.post('/api/v1/projects/:key/code/branches', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    const input = parse(CreateBranchInputSchema, req.body)
    requireGit(repos.rt)
    const access = await loadProjectAccess(db, req.user, key)
    assertCan(access, 'code.edit')
    const repo = await repoService.requireRepo(db, access)
    await createBranch(repos, repo, access.project, req.user, req.client, input)
    reply.code(201)
    return { name: input.name, from: input.from }
  })

  // ─── Tree & files ──────────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:key/code/tree', async (req) => {
    const { key } = parse(KeyParams, req.params)
    const { branch, path } = parse(TreeQuery, req.query)
    return repoService.listTree(db, req.user, key, branch, path)
  })

  app.get('/api/v1/projects/:key/code/paths', async (req) => {
    const { key } = parse(KeyParams, req.params)
    const { branch } = parse(BranchQuery, req.query)
    return repoService.listPaths(db, req.user, key, branch)
  })

  app.get('/api/v1/projects/:key/code/file', async (req) => {
    const { key } = parse(KeyParams, req.params)
    const { branch, path } = parse(FileQuery, req.query)
    return repoService.getFile(db, req.user, key, branch, path)
  })

  // ─── Run branches: a workflow run's work, reported by VS Code (never pushed), shown over the default branch ──

  app.get('/api/v1/projects/:key/code/run-branches', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return runBranches.listRunBranches(db, req.user, key)
  })

  app.get('/api/v1/projects/:key/code/run-branches/:runId', async (req) => {
    const { key, runId } = parse(RunBranchParams, req.params)
    return runBranches.getRunBranch(db, req.user, key, runId)
  })

  app.get('/api/v1/projects/:key/code/run-branches/:runId/tree', async (req) => {
    const { key, runId } = parse(RunBranchParams, req.params)
    const { path } = parse(RunTreeQuery, req.query)
    return runBranches.runBranchTree(db, req.user, key, runId, path)
  })

  app.get('/api/v1/projects/:key/code/run-branches/:runId/file', async (req) => {
    const { key, runId } = parse(RunBranchParams, req.params)
    const { path } = parse(RunFileQuery, req.query)
    return runBranches.runBranchFile(db, req.user, key, runId, path)
  })

  app.get('/api/v1/projects/:key/code/blobs/:sha', async (req) => {
    const { key, sha } = parse(BlobParams, req.params)
    return repoService.getBlob(db, req.user, key, sha)
  })

  // ─── Drafts & commits ──────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:key/code/drafts', async (req) => {
    const { key } = parse(KeyParams, req.params)
    const { branch } = parse(BranchQuery, req.query)
    return repoService.listDrafts(db, req.user, key, branch)
  })

  app.put('/api/v1/projects/:key/code/drafts', { bodyLimit: DRAFT_BODY_LIMIT }, async (req) => {
    const { key } = parse(KeyParams, req.params)
    return repoService.saveDraft(db, caller(req), key, parse(SaveDraftInputSchema, req.body))
  })

  app.delete('/api/v1/projects/:key/code/drafts', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    const { branch, path } = parse(DraftQuery, req.query)
    await repoService.discardDraft(db, caller(req), key, branch, path)
    return reply.code(204).send()
  })

  app.post('/api/v1/projects/:key/code/commits', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    const input = parse(CommitInputSchema, req.body)
    const access = await loadProjectAccess(db, req.user, key)
    assertCan(access, 'code.edit')
    const repo = await repoService.requireRepo(db, access)
    reply.code(201)
    return commitDrafts(repos, repo, access.project, req.user, req.client, input)
  })

  // ─── Workspace files (blank projects: add / delete a file, committed at once) ────────────────

  async function workspaceContext(req: FastifyRequest, key: string) {
    const access = await loadProjectAccess(db, req.user, key)
    assertCan(access, 'code.edit')
    const repo = await repoService.requireRepo(db, access)
    if (!isWorkspace(repo)) throw new HttpError(409, 'not_a_workspace', 'Files can be added and deleted here only in a workspace — commit to the repository instead.')
    return { repo, ctx: { db, bus: repos.rt.bus, maxFileBytes: repos.rt.maxFileBytes, project: access.project, user: req.user, via: req.client } }
  }

  app.post('/api/v1/projects/:key/code/files', { bodyLimit: DRAFT_BODY_LIMIT }, async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    const input = parse(CreateRepoFileInputSchema, req.body)
    const { repo, ctx } = await workspaceContext(req, key)
    reply.code(201)
    return createWorkspaceFile(ctx, repo, input)
  })

  app.delete('/api/v1/projects/:key/code/files', async (req) => {
    const { key } = parse(KeyParams, req.params)
    const input = parse(DeleteRepoFileInputSchema, req.query)
    const { repo, ctx } = await workspaceContext(req, key)
    return deleteWorkspaceFile(ctx, repo, input)
  })
}
