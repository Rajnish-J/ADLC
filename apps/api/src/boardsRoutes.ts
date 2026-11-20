// Azure Boards (/api/v1): a project's link to an Azure DevOps project, the caller's Azure DevOps identity, and
// syncing the caller's assigned work items into stories. Needs the repository runtime (the organisation's Git
// connection tokens are decrypted there).

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { LinkAdoConnectionInputSchema, SetAdoTokenInputSchema, UpdateBoardsIdentityInputSchema, UpdateProjectBoardsInputSchema } from '@sdlc/contracts'
import { parse } from './http'
import type { RepoManager } from './repo/jobs'
import { caller, KeyParams } from './routeKit'
import {
  getBoardsIdentity,
  getProjectBoards,
  listBoardsAreas,
  pruneOutOfArea,
  setBoardsIdentity,
  syncMyWorkItems,
  updateProjectBoards,
  type BoardsDeps,
} from './services/boardsSync'
import type { ServiceDeps } from './services/context'
import { deleteAdoToken, getAdoToken, linkAdoConnection, listMyWorkItems, setAdoToken } from './services/myWorkItems'

const SyncQuery = z.object({ force: z.enum(['true', 'false']).optional() })
const PruneQuery = z.object({ dryRun: z.enum(['true', 'false']).optional() })
const AreasQuery = z.object({ organization: z.string().trim().min(1).max(100), project: z.string().trim().min(1).max(200) })

export function registerBoardsRoutes(app: FastifyInstance, deps: ServiceDeps, repos: RepoManager): void {
  const boards: BoardsDeps = { ...deps, rt: repos.rt }

  app.get('/api/v1/projects/:key/boards', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return getProjectBoards(boards, req.user, key)
  })

  app.put('/api/v1/projects/:key/boards', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return updateProjectBoards(boards, caller(req), key, parse(UpdateProjectBoardsInputSchema, req.body))
  })

  /** The area paths of an Azure DevOps project, for picking the one this project syncs from. */
  app.get('/api/v1/projects/:key/boards/areas', async (req) => {
    const { key } = parse(KeyParams, req.params)
    const q = parse(AreasQuery, req.query)
    return { areas: await listBoardsAreas(boards, req.user, key, q.organization, q.project) }
  })

  /** Stories synced from work items outside the project's area: listed (?dryRun=true) or deleted. Owners only. */
  app.post('/api/v1/projects/:key/boards/prune', async (req) => {
    const { key } = parse(KeyParams, req.params)
    const { dryRun } = parse(PruneQuery, req.query)
    return pruneOutOfArea(boards, caller(req), key, { dryRun: dryRun === 'true' })
  })

  /** Sync my assigned work items into one project (always runs). */
  app.post('/api/v1/projects/:key/stories/sync', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return syncMyWorkItems(boards, caller(req), { projectKey: key, force: true })
  })

  /** Sync my assigned work items into every linked project I belong to (throttled unless ?force=true). */
  app.post('/api/v1/me/stories/sync', async (req) => {
    const { force } = parse(SyncQuery, req.query)
    return syncMyWorkItems(boards, caller(req), { force: force === 'true' })
  })

  app.get('/api/v1/me/boards-identity', async (req) => getBoardsIdentity(deps.db, req.user))

  app.put('/api/v1/me/boards-identity', async (req) => setBoardsIdentity(deps.db, req.user, parse(UpdateBoardsIdentityInputSchema, req.body)))

  // My work items: the caller's own Azure DevOps token (null when none) and everything assigned to them, read live.
  const mine = { db: deps.db, rt: repos.rt }

  app.get('/api/v1/me/ado-token', async (req) => getAdoToken(deps.db, req.user))

  app.put('/api/v1/me/ado-token', async (req) => setAdoToken(mine, req.user, parse(SetAdoTokenInputSchema, req.body)))

  /** Use an organisation Azure Git connection whose token is mine, instead of adding a token. */
  app.put('/api/v1/me/ado-token/connection', async (req) => linkAdoConnection(mine, req.user, parse(LinkAdoConnectionInputSchema, req.body)))

  app.delete('/api/v1/me/ado-token', async (req) => deleteAdoToken(deps.db, req.user))

  app.get('/api/v1/me/work-items', async (req) => listMyWorkItems(mine, req.user))
}
