// Engine settings (/api/v1): the caller's agent-engine preference, their connected VS Code clients, and a
// project's own fields and engine limits.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ClientPresenceInputSchema, UpdatePreferencesInputSchema, UpdateProjectInputSchema } from '@sdlc/contracts'
import { parse } from './http'
import { caller, KeyParams } from './routeKit'
import type { ServiceDeps } from './services/context'
import * as settings from './services/settings'

const ClientParams = z.object({ clientId: z.string().regex(/^[\w-]{8,64}$/) })

export function registerSettingsRoutes(app: FastifyInstance, deps: ServiceDeps): void {
  app.get('/api/v1/me/settings', async (req) => settings.mySettings(deps.db, req.user.id))

  app.put('/api/v1/me/preferences', async (req) =>
    settings.updatePreferences(deps, caller(req), parse(UpdatePreferencesInputSchema, req.body)),
  )

  app.put('/api/v1/me/clients/:clientId', async (req) => {
    const { clientId } = parse(ClientParams, req.params)
    return settings.reportPresence(deps, caller(req), clientId, parse(ClientPresenceInputSchema, req.body))
  })

  app.delete('/api/v1/me/clients/:clientId', async (req, reply) => {
    const { clientId } = parse(ClientParams, req.params)
    await settings.removePresence(deps, caller(req), clientId)
    return reply.code(204).send()
  })

  app.patch('/api/v1/projects/:key', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return settings.updateProject(deps, caller(req), key, parse(UpdateProjectInputSchema, req.body))
  })
}
