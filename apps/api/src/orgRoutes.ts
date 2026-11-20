// Organisation administration and system status (/api/v1): people and org roles, archiving / restoring projects,
// and Settings → System. Everything is org admin only, except archiving, which a project owner may do too.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { UpdateOrgRoleInputSchema } from '@sdlc/contracts'
import type { Config } from './config'
import { parse } from './http'
import { caller, KeyParams } from './routeKit'
import type { ServiceDeps } from './services/context'
import * as org from './services/org'
import { systemStatus } from './services/system'

const UserParams = z.object({ userId: z.string().uuid() })
const IdParams = z.object({ id: z.string().uuid() })

export function registerOrgRoutes(app: FastifyInstance, deps: ServiceDeps, config: Config): void {
  app.get('/api/v1/org/people', async (req) => org.listPeople(deps.db, req.user))

  app.patch('/api/v1/org/people/:userId', async (req) => {
    const { userId } = parse(UserParams, req.params)
    return org.setOrgRole(deps, caller(req), userId, parse(UpdateOrgRoleInputSchema, req.body).orgRole)
  })

  app.post('/api/v1/projects/:key/archive', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    await org.archiveProject(deps, caller(req), key)
    return reply.code(204).send()
  })

  app.get('/api/v1/org/projects/archived', async (req) => org.listArchived(deps.db, req.user))

  app.post('/api/v1/org/projects/:id/restore', async (req) => {
    const { id } = parse(IdParams, req.params)
    return org.restoreProject(deps, caller(req), id)
  })

  app.get('/api/v1/admin/system', async (req) => systemStatus(deps, deps.repos, config, req.user))
}
