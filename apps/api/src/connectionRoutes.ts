// Git connections (/api/v1/git-connections): the organisation's GitHub / Azure Repos access tokens, managed by org
// admins in one place and used automatically whenever a project's repository is cloned, synced or committed to.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CreateGitConnectionInputSchema, GIT_CONNECTION_PROVIDERS, UpdateGitConnectionInputSchema } from '@sdlc/contracts'
import { parse } from './http'
import * as connections from './repo/connections'
import type { RepoManager } from './repo/jobs'
import { caller } from './routeKit'

const IdParams = z.object({ id: z.string().uuid() })
const ReposQuery = z.object({ q: z.string().trim().max(200).optional() })
const TestInputSchema = z.object({
  provider: z.enum(GIT_CONNECTION_PROVIDERS),
  owner: z.string().trim().max(100).optional(),
  token: z.string().trim().min(1).max(500),
})

export function registerConnectionRoutes(app: FastifyInstance, repos: RepoManager): void {
  const { db } = repos.rt

  app.get('/api/v1/git-connections', async (req) => connections.listConnections(db, req.user))

  /** Repositories the connection's token can reach — to import one as a new project. */
  app.get('/api/v1/git-connections/:id/repositories', async (req) => {
    const { id } = parse(IdParams, req.params)
    const { q } = parse(ReposQuery, req.query)
    return connections.listConnectionRepos(repos.rt, req.user, id, q)
  })

  /** Check a token with the provider without saving it. */
  app.post('/api/v1/git-connections/test', async (req) => {
    const input = parse(TestInputSchema, req.body)
    return connections.testToken(req.user, { ...input, owner: input.owner || undefined })
  })

  app.post('/api/v1/git-connections', async (req, reply) => {
    const input = parse(CreateGitConnectionInputSchema, req.body)
    reply.code(201)
    return connections.createConnection(repos, caller(req), input)
  })

  app.patch('/api/v1/git-connections/:id', async (req) => {
    const { id } = parse(IdParams, req.params)
    return connections.updateConnection(repos, caller(req), id, parse(UpdateGitConnectionInputSchema, req.body))
  })

  app.delete('/api/v1/git-connections/:id', async (req, reply) => {
    const { id } = parse(IdParams, req.params)
    await connections.deleteConnection(db, caller(req), id)
    return reply.code(204).send()
  })
}
