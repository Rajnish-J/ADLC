// The board's drag and drop and a story's activity (/api/v1). Permission checks live in the services.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { MoveStoryInputSchema } from '@sdlc/contracts'
import { parse } from './http'
import { caller, StoryParams } from './routeKit'
import { storyActivity } from './services/activity'
import type { ServiceDeps } from './services/context'
import { moveStory } from './services/stories'

const ActivityQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export function registerBoardRoutes(app: FastifyInstance, deps: ServiceDeps): void {
  /** A drop on the board: a column (`to`) and, optionally, the cards it landed between. */
  app.post('/api/v1/projects/:key/stories/:number/move', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return moveStory(deps, caller(req), key, number, parse(MoveStoryInputSchema, req.body))
  })

  app.get('/api/v1/projects/:key/stories/:number/activity', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return storyActivity(deps.db, req.user, key, number, parse(ActivityQuery, req.query))
  })
}
