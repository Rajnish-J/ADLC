// Shared route helpers: path-parameter schemas and the caller (user + client) every service call needs.

import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Caller } from './services/context'

export const KeyParams = z.object({ key: z.string().min(1).max(20) })
export const StoryParams = KeyParams.extend({ number: z.coerce.number().int().positive() })

export function caller(req: FastifyRequest): Caller {
  return { user: req.user, via: req.client }
}
