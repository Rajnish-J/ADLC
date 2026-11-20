// Story and project memory (/api/v1). Permission checks live in the memory service.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  CreateMemoryInputSchema,
  DecideMemoryInputSchema,
  MemoryContextQuerySchema,
  MemoryListQuerySchema,
  UpdateMemoryInputSchema,
} from '@sdlc/contracts'
import { parse } from './http'
import { caller, KeyParams, StoryParams } from './routeKit'
import type { ServiceDeps } from './services/context'
import * as memory from './services/memory'
import { projectMemoryContext, storyMemoryContext } from './services/memoryContext'

const ItemParams = KeyParams.extend({ id: z.string().uuid() })

export function registerMemoryRoutes(app: FastifyInstance, deps: ServiceDeps): void {
  const { db } = deps

  app.get('/api/v1/projects/:key/memory', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return memory.listProjectMemory(db, req.user, key, parse(MemoryListQuerySchema, req.query), deps.memoryIndex)
  })

  app.post('/api/v1/projects/:key/memory', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    reply.code(201)
    return memory.addProjectMemory(deps, caller(req), key, parse(CreateMemoryInputSchema, req.body))
  })

  app.get('/api/v1/projects/:key/stories/:number/memory', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return memory.listStoryMemory(db, req.user, key, number)
  })

  app.post('/api/v1/projects/:key/stories/:number/memory', async (req, reply) => {
    const { key, number } = parse(StoryParams, req.params)
    reply.code(201)
    return memory.addStoryMemory(deps, caller(req), key, number, parse(CreateMemoryInputSchema, req.body))
  })

  /** What an agent working on the story is told: story + project memory as Markdown (`runId` records it for the run). */
  app.get('/api/v1/projects/:key/stories/:number/memory/context', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return storyMemoryContext(deps, req.user, key, number, parse(MemoryContextQuerySchema, req.query))
  })

  /** What a quick fix (no story) is told: project memory related to its prompt (`q`). */
  app.get('/api/v1/projects/:key/memory/context', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return projectMemoryContext(deps, req.user, key, parse(MemoryContextQuerySchema, req.query))
  })

  app.patch('/api/v1/projects/:key/memory/:id', async (req) => {
    const { key, id } = parse(ItemParams, req.params)
    return memory.updateMemory(deps, caller(req), key, id, parse(UpdateMemoryInputSchema, req.body))
  })

  app.post('/api/v1/projects/:key/memory/:id/promote', async (req) => {
    const { key, id } = parse(ItemParams, req.params)
    return memory.promoteMemory(deps, caller(req), key, id)
  })

  app.post('/api/v1/projects/:key/memory/:id/decide', async (req) => {
    const { key, id } = parse(ItemParams, req.params)
    return memory.decideMemory(deps, caller(req), key, id, parse(DecideMemoryInputSchema, req.body))
  })

  app.post('/api/v1/projects/:key/memory/:id/archive', async (req) => {
    const { key, id } = parse(ItemParams, req.params)
    return memory.archiveMemory(deps, caller(req), key, id)
  })
}
