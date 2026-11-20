import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { registerAuth } from './auth'
import type { Config } from './config'
import { createDb } from './db/client'
import { EventBus } from './events'
import { HttpError } from './http'
import { configureOrchestrator, OrchestratorClient } from './orchestrator/client'
import { OrchestratorEventBridge } from './orchestrator/eventBridge'
import { registerInternalRoutes } from './orchestrator/internalRoutes'
import { RepoManager } from './repo/jobs'
import { createRepoRuntime, detectGit } from './repo/runtime'
import { registerRoutes } from './routes'
import { createProfileService } from './services/projectProfile'
import { createEmbeddingRuntime } from './ai/embeddings'
import { registerAiRoutes } from './aiRoutes'
import { createChatRuntime } from './chat/llm'
import { createContextCurator } from './services/contextCurator'
import { createMemoryIndexer } from './services/memoryIndex'

export function buildApp(config: Config): FastifyInstance {
  const { db, pool } = createDb(config.DATABASE_URL)
  const bus = new EventBus()
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'test' ? 'warn' : 'info' },
  })

  registerAuth(app, db, config)

  // Action endpoints (promote, archive, pick up, …) take no body; accept an empty one even when a client still
  // sends `content-type: application/json`, instead of Fastify's default 400.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8')
    if (text.trim() === '') return done(null, undefined)
    try {
      done(null, JSON.parse(text))
    } catch {
      const err = new Error('The request body is not valid JSON.') as Error & { statusCode: number }
      err.statusCode = 400
      done(err, undefined)
    }
  })

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details })
    }
    // Fastify's own client errors (malformed JSON, unsupported media type, …).
    const status = err.statusCode
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: err.message })
    }
    req.log.error({ err }, 'Unhandled error')
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong.' })
  })

  // The orchestrator service owns the catalog and drives platform runs; its events reach SSE through LISTEN.
  configureOrchestrator(new OrchestratorClient(config.ORCHESTRATOR_URL, config.ORCHESTRATOR_TOKEN))
  const orchestratorEvents = new OrchestratorEventBridge(config.DATABASE_URL, bus, app.log)

  const repos = new RepoManager(createRepoRuntime(db, bus, app.log, config))
  // The AI model (chat deployment) and the embedding deployment, shared by the profiler, the run-context curator
  // and semantic memory search.
  const chatRuntime = createChatRuntime(config)
  const embeddings = createEmbeddingRuntime(config)
  const profiles = createProfileService({ db, bus }, config, app.log, { runtime: chatRuntime })
  const memoryIndex = createMemoryIndexer({ db, bus }, embeddings, app.log)
  const curator = createContextCurator(db, chatRuntime, app.log)
  const deps = { db, bus, repos, profiles, memoryIndex, curator }
  registerRoutes(app, deps, config)
  registerAiRoutes(app, deps, chatRuntime)
  registerInternalRoutes(app, deps, config)
  app.addHook('onReady', async () => {
    await orchestratorEvents.start()
    await detectGit(repos.rt)
    // Syncs interrupted by a restart run again; failures are logged, never fatal to startup.
    await repos.resume().catch((err) => app.log.error({ err }, 'Could not resume repository syncs'))
    await profiles.resume().catch((err) => app.log.error({ err }, 'Could not resume project profile jobs'))
    // Embed memory that changed while the API was down (only items whose text changed are sent).
    await memoryIndex.resume().catch((err) => app.log.error({ err }, 'Could not resume the memory index'))
  })
  app.addHook('onClose', async () => {
    await orchestratorEvents.stop()
    repos.stop()
    profiles.stop()
    memoryIndex.stop()
    await pool.end()
  })
  return app
}
