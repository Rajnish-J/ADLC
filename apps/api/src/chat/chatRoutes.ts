// Chat routes (/api/v1/chat…): config, the assistants and their tools, the user's threads, the streamed turn,
// and the drafts the assistants build (read, edit in Review, submit, discard).

import type { FastifyInstance } from 'fastify'
import type { UIMessage } from 'ai'
import { z } from 'zod'
import {
  CHAT_TOOL_MODES,
  ChatRequestSchema,
  CreateChatThreadInputSchema,
  UpdateChatDraftInputSchema,
  UpdateChatThreadInputSchema,
  type ChatAgentSummary,
  type ChatConfig,
  type ChatDraft,
  type ChatThreadDetail,
  type ChatThreadSummary,
  type ChatToolInfo,
} from '@sdlc/contracts'
import { loadProjectAccess } from '../access'
import type { Config } from '../config'
import { HttpError, parse } from '../http'
import { caller } from '../routeKit'
import type { ServiceDeps } from '../services/context'
import { toAgentSummary } from './agents/loader'
import { createChatService, runTurn, setupTurn } from './engine'
import { createChatRuntime } from './llm'
import {
  createThread,
  editDraft,
  listDrafts,
  listThreads,
  loadDraft,
  loadMessages,
  loadThread,
  setDraftStatus,
  threadProjectKey,
  toChatDraft,
  toThreadSummary,
  updateThread,
} from './store'
import { submitDraft } from './submit'

const IdParams = z.object({ id: z.string().uuid() })
const ToolsQuery = z.object({
  agent: z.string().min(1).max(60),
  project: z.string().min(1).max(20).optional(),
  mode: z.enum(CHAT_TOOL_MODES).default('auto'),
})

export function registerChatRoutes(app: FastifyInstance, deps: ServiceDeps, config: Config): void {
  const { db } = deps
  const runtime = createChatRuntime(config)
  const svc = createChatService(runtime)
  if (!runtime.config.enabled) app.log.warn(runtime.config.reason ?? 'Chat is disabled.')

  app.get('/api/v1/chat/config', async (): Promise<ChatConfig> => runtime.config)

  app.get('/api/v1/chat/agents', async (): Promise<ChatAgentSummary[]> => svc.agents.map(toAgentSummary))

  /** The tools an assistant would get for this user, project and mode — with the reason for each one it can't use. */
  app.get('/api/v1/chat/tools', async (req): Promise<ChatToolInfo[]> => {
    const q = parse(ToolsQuery, req.query)
    const setup = await setupTurn(deps, caller(req), svc, { agent: q.agent, projectKey: q.project ?? null, toolMode: q.mode, disabledTools: [] })
    return setup.tools.map(({ def: _def, ...info }) => info)
  })

  // ─── Threads ───────────────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/chat/threads', async (req): Promise<ChatThreadSummary[]> => listThreads(db, req.user))

  app.post('/api/v1/chat/threads', async (req, reply): Promise<ChatThreadSummary> => {
    const input = parse(CreateChatThreadInputSchema, req.body)
    const access = input.projectKey ? await loadProjectAccess(db, req.user, input.projectKey) : null
    const row = await createThread(db, req.user, { agent: svc.agent(input.agent).name, projectId: access?.project.id ?? null, model: input.model })
    reply.code(201)
    return toThreadSummary(row, access?.project.key ?? null)
  })

  app.get('/api/v1/chat/threads/:id', async (req): Promise<ChatThreadDetail> => {
    const { id } = parse(IdParams, req.params)
    const thread = await loadThread(db, req.user, id)
    const [messages, drafts, key] = await Promise.all([loadMessages(db, id), listDrafts(db, id), threadProjectKey(db, thread)])
    return {
      thread: toThreadSummary(thread, key),
      messages: messages as ChatThreadDetail['messages'],
      drafts: await Promise.all(drafts.map((d) => toChatDraft(db, d))),
    }
  })

  /** Just the drafts — refreshed by the clients while an assistant is working on one. */
  app.get('/api/v1/chat/threads/:id/drafts', async (req): Promise<ChatDraft[]> => {
    const { id } = parse(IdParams, req.params)
    await loadThread(db, req.user, id)
    return Promise.all((await listDrafts(db, id)).map((d) => toChatDraft(db, d)))
  })

  app.patch('/api/v1/chat/threads/:id', async (req): Promise<ChatThreadSummary> => {
    const { id } = parse(IdParams, req.params)
    const input = parse(UpdateChatThreadInputSchema, req.body)
    await loadThread(db, req.user, id)
    let projectId: string | null | undefined
    let key: string | null | undefined
    if (input.projectKey !== undefined) {
      const access = input.projectKey ? await loadProjectAccess(db, req.user, input.projectKey) : null
      projectId = access?.project.id ?? null
      key = access?.project.key ?? null
    }
    const row = await updateThread(db, id, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.agent !== undefined ? { agent: svc.agent(input.agent).name } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    })
    return toThreadSummary(row, key !== undefined ? key : await threadProjectKey(db, row))
  })

  app.delete('/api/v1/chat/threads/:id', async (req) => {
    const { id } = parse(IdParams, req.params)
    await loadThread(db, req.user, id)
    await updateThread(db, id, { archivedAt: new Date() })
    return { ok: true }
  })

  // ─── The turn (streamed) ───────────────────────────────────────────────────────────────────────

  app.post('/api/v1/chat', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    if (!runtime.config.enabled) throw new HttpError(503, 'chat_disabled', runtime.config.reason ?? 'Chat is not configured.')
    const input = parse(ChatRequestSchema, req.body)
    const thread = await loadThread(db, req.user, input.threadId)
    await runTurn(
      deps,
      caller(req),
      svc,
      {
        thread,
        message: input.message as unknown as UIMessage,
        agent: input.agent,
        projectKey: input.projectKey,
        model: input.model,
        toolMode: input.toolMode,
        disabledTools: input.disabledTools,
      },
      () => {
        reply.hijack()
        return reply.raw
      },
      req.log,
    )
  })

  // ─── Drafts ────────────────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/chat/drafts/:id', async (req): Promise<ChatDraft> => {
    const { id } = parse(IdParams, req.params)
    const { draft } = await loadDraft(db, req.user, id)
    return toChatDraft(db, draft)
  })

  /** The user's own edits from the Review form. */
  app.patch('/api/v1/chat/drafts/:id', async (req): Promise<ChatDraft> => {
    const { id } = parse(IdParams, req.params)
    const input = parse(UpdateChatDraftInputSchema, req.body)
    const { draft } = await loadDraft(db, req.user, id)
    return toChatDraft(db, await editDraft(db, draft, input.version, input.data))
  })

  app.post('/api/v1/chat/drafts/:id/submit', async (req): Promise<ChatDraft> => {
    const { id } = parse(IdParams, req.params)
    const { draft } = await loadDraft(db, req.user, id)
    const c = caller(req)
    return submitDraft(deps, { user: c.user, via: `${c.via}:chat` }, draft)
  })

  app.post('/api/v1/chat/drafts/:id/discard', async (req): Promise<ChatDraft> => {
    const { id } = parse(IdParams, req.params)
    const { draft } = await loadDraft(db, req.user, id)
    return toChatDraft(db, await setDraftStatus(db, draft.id, 'discarded'))
  })
}
