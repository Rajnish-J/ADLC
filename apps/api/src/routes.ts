// HTTP routes (/api/v1). Thin: parse input with the contract schemas, call a service, return the contract
// shape. Permission checks live in the services/access layer, never only in a client.

import type { FastifyInstance } from 'fastify'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  AddMemberInputSchema,
  AssignInputSchema,
  CreateAccessTokenInputSchema,
  CreateProjectInputSchema,
  CreateStoryInputSchema,
  PLATFORM_EVENT,
  TransitionInputSchema,
  UpdateMemberInputSchema,
  UpdateStoryInputSchema,
  can,
  type AuditEntry,
  type Me,
  type PlatformEvent,
  eventTargetUser,
} from '@sdlc/contracts'
import { actorOf, assertCan, loadProjectAccess } from './access'
import type { Config } from './config'
import { auditLog, projectMembers, projects, users } from './db/schema'
import { toAuditEntries, toUser } from './dto'
import { forbidden, parse } from './http'
import { registerBoardRoutes } from './boardRoutes'
import { registerBoardsRoutes } from './boardsRoutes'
import { registerCatalogRoutes } from './catalogRoutes'
import { registerChatRoutes } from './chat/chatRoutes'
import { registerMemoryRoutes } from './memoryRoutes'
import { registerProfileRoutes } from './profileRoutes'
import { caller, KeyParams, StoryParams } from './routeKit'
import type { ServiceDeps } from './services/context'
import * as accessTokenService from './services/accessTokens'
import * as projectService from './services/projects'
import * as storyService from './services/stories'
import { registerWorkRoutes } from './workRoutes'
import { registerSessionRoutes } from './sessionRoutes'
import { registerSettingsRoutes } from './settingsRoutes'
import { registerRepoRoutes } from './repoRoutes'
import { registerConnectionRoutes } from './connectionRoutes'
import { registerOrgRoutes } from './orgRoutes'

const MemberParams = KeyParams.extend({ userId: z.string().uuid() })

export function registerRoutes(app: FastifyInstance, deps: ServiceDeps, config: Config): void {
  const { db } = deps

  app.get('/healthz', async () => ({ ok: true }))

  // ─── Identity ──────────────────────────────────────────────────────────────────────────────────

  if (config.AUTH_MODE === 'dev') {
    /** Dev sign-in picker: every seeded user. Only registered in AUTH_MODE=dev (refused in production). */
    app.get('/api/v1/dev/users', async () => {
      const rows = await db.select().from(users).orderBy(asc(users.displayName))
      return rows.map(toUser)
    })
  }

  app.get('/api/v1/me', async (req): Promise<Me> => {
    const user = req.user
    return { user: toUser(user), canCreateProject: can(actorOf(user), undefined, 'project.create') }
  })

  /** Org directory — for picking project members. */
  app.get('/api/v1/users', async (req) => {
    const rows = await db.select().from(users).where(eq(users.orgId, req.user.orgId)).orderBy(asc(users.displayName))
    return rows.map(toUser)
  })

  app.get('/api/v1/me/stories', async (req) => storyService.myStories(db, req.user))

  // Personal access tokens (the VS Code extension's sign-in). Listing and creating need a real sign-in: a token can
  // revoke itself but can't see or mint others, so a leaked one can't be used to keep access.
  const signedInInPerson = (method: string): void => {
    if (method === 'token') throw forbidden('Manage access tokens from the web app (Settings → VS Code), not with a token.')
  }
  app.get('/api/v1/me/access-tokens', async (req) => {
    signedInInPerson(req.authMethod)
    return accessTokenService.listAccessTokens(db, req.user)
  })
  app.post('/api/v1/me/access-tokens', async (req, reply) => {
    signedInInPerson(req.authMethod)
    const input = parse(CreateAccessTokenInputSchema, req.body)
    reply.code(201)
    return accessTokenService.createAccessToken(db, caller(req), input)
  })
  app.delete('/api/v1/me/access-tokens/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    return accessTokenService.revokeAccessToken(db, caller(req), id)
  })

  // ─── Projects & members ────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects', async (req) => projectService.listProjects(db, req.user))

  app.post('/api/v1/projects', async (req, reply) => {
    const input = parse(CreateProjectInputSchema, req.body)
    reply.code(201)
    return projectService.createProject(deps, caller(req), input)
  })

  app.get('/api/v1/projects/:key', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return projectService.projectDetail(db, req.user, key)
  })

  app.post('/api/v1/projects/:key/members', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    reply.code(201)
    return projectService.addMember(deps, caller(req), key, parse(AddMemberInputSchema, req.body))
  })

  app.patch('/api/v1/projects/:key/members/:userId', async (req) => {
    const { key, userId } = parse(MemberParams, req.params)
    return projectService.updateMember(deps, caller(req), key, userId, parse(UpdateMemberInputSchema, req.body))
  })

  app.delete('/api/v1/projects/:key/members/:userId', async (req) => {
    const { key, userId } = parse(MemberParams, req.params)
    return projectService.removeMember(deps, caller(req), key, userId)
  })

  // ─── Stories ───────────────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:key/stories', async (req) => {
    const { key } = parse(KeyParams, req.params)
    return storyService.listStories(db, req.user, key)
  })

  app.post('/api/v1/projects/:key/stories', async (req, reply) => {
    const { key } = parse(KeyParams, req.params)
    reply.code(201)
    return storyService.createStory(deps, caller(req), key, parse(CreateStoryInputSchema, req.body))
  })

  app.get('/api/v1/projects/:key/stories/:number', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return storyService.getStory(db, req.user, key, number)
  })

  app.patch('/api/v1/projects/:key/stories/:number', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return storyService.updateStory(deps, caller(req), key, number, parse(UpdateStoryInputSchema, req.body))
  })

  app.post('/api/v1/projects/:key/stories/:number/transition', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return storyService.transitionStory(deps, caller(req), key, number, parse(TransitionInputSchema, req.body))
  })

  app.post('/api/v1/projects/:key/stories/:number/pickup', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return storyService.pickUpStory(deps, caller(req), key, number)
  })

  app.post('/api/v1/projects/:key/stories/:number/assign', async (req) => {
    const { key, number } = parse(StoryParams, req.params)
    return storyService.assignStory(deps, caller(req), key, number, parse(AssignInputSchema, req.body))
  })

  registerCatalogRoutes(app, deps)
  registerChatRoutes(app, deps, config)
  registerMemoryRoutes(app, deps)
  if (deps.profiles) registerProfileRoutes(app, deps.profiles)
  registerWorkRoutes(app, deps, config)
  registerSessionRoutes(app, deps)
  registerBoardRoutes(app, deps)
  registerSettingsRoutes(app, deps)
  registerOrgRoutes(app, deps, config)
  if (deps.repos) {
    registerRepoRoutes(app, deps.repos)
    registerConnectionRoutes(app, deps.repos)
    registerBoardsRoutes(app, deps, deps.repos)
  }

  // ─── Audit ─────────────────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:key/audit', async (req): Promise<AuditEntry[]> => {
    const { key } = parse(KeyParams, req.params)
    const access = await loadProjectAccess(db, req.user, key)
    assertCan(access, 'audit.view')
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.projectId, access.project.id))
      .orderBy(desc(auditLog.id))
      .limit(200)
    return toAuditEntries(db, rows)
  })

  // ─── Live events (SSE) ─────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/events', async (req, reply) => {
    const user = req.user
    const isAdmin = user.orgRole === 'org_admin'

    // Which projects this connection may hear about. Refreshed when membership may have changed.
    let visible = new Set<string>()
    const refreshVisible = async (): Promise<void> => {
      if (isAdmin) return
      const rows = await db
        .select({ key: projects.key })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(and(eq(projectMembers.userId, user.id), isNull(projects.archivedAt)))
      visible = new Set(rows.map((r) => r.key))
    }
    await refreshVisible()

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (event: PlatformEvent): void => {
      res.write(`event: ${PLATFORM_EVENT}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    send({ type: 'ready' })

    const unsubscribe = deps.bus.subscribe((event) => {
      if (event.type === 'ready') return
      const target = eventTargetUser(event)
      if (target !== null) {
        if (target === user.id) send(event)
        return
      }
      if (!('projectKey' in event)) return
      void (async () => {
        if (event.type === 'project.changed') await refreshVisible()
        if (isAdmin || visible.has(event.projectKey)) send(event)
      })().catch((err) => req.log.warn({ err }, 'SSE delivery failed'))
    })
    // Comment lines keep proxies from closing an idle stream.
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
    req.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
}
