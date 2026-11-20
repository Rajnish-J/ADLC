// The project profile (/api/v1). Reading is open to project members; generating, editing and deciding need
// `memory.curate` (checked in the service).

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DecideProfileInputSchema, GenerateProfileInputSchema, UpdateProfileInputSchema } from '@sdlc/contracts'
import { parse } from './http'
import { caller, KeyParams } from './routeKit'
import type { ProfileService } from './services/projectProfile'

const VersionParams = KeyParams.extend({ id: z.string().uuid() })
const DownloadQuery = z.object({ id: z.string().uuid().optional() })

export function registerProfileRoutes(app: FastifyInstance, profiles: ProfileService): void {
  app.get('/api/v1/projects/:key/profile', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return profiles.state(req.user, key)
  })

  app.get('/api/v1/projects/:key/profile/versions', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return profiles.versions(req.user, key)
  })

  app.get('/api/v1/projects/:key/profile/versions/:id', async (req) => {
    const { key, id } = parse(VersionParams, req.params)
    return profiles.version(req.user, key, id)
  })

  /** Start writing the profile from a branch of the linked repository (202: it is written in the background). */
  app.post('/api/v1/projects/:key/profile/generate', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    reply.code(202)
    return profiles.generate(caller(req), key, parse(GenerateProfileInputSchema, req.body ?? {}))
  })

  app.post('/api/v1/projects/:key/profile/versions/:id/decide', async (req) => {
    const { key, id } = parse(VersionParams, req.params)
    return profiles.decide(caller(req), key, id, parse(DecideProfileInputSchema, req.body))
  })

  app.patch('/api/v1/projects/:key/profile/versions/:id', async (req) => {
    const { key, id } = parse(VersionParams, req.params)
    return profiles.update(caller(req), key, id, parse(UpdateProfileInputSchema, req.body))
  })

  /** The accepted profile (or `?id=` a version) as a Markdown file. */
  app.get('/api/v1/projects/:key/profile/download', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    const { id } = parse(DownloadQuery, req.query)
    const file = await profiles.download(req.user, key, id)
    reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="${file.fileName}"`)
    return file.markdown
  })
}
