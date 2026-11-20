// One chat turn: resolve the thread, assistant, project and toolset; merge what the client sent into the stored
// history (only what a client may legitimately change); stream the model's answer; persist the result.

import type { ServerResponse } from 'node:http'
import { convertToModelMessages, createIdGenerator, isStepCount, streamText, type LanguageModelUsage, type UIMessage } from 'ai'
import {
  AskUserOutputSchema,
  CLIENT_RESOLVED_TOOLS,
  DRAFT_KIND_LABELS,
  DRAFT_SUBMITTED_PART,
  HandoffOutputSchema,
  type ChatMessageMetadata,
  type ChatToolInfo,
  type ChatToolMode,
  type DraftKind,
} from '@sdlc/contracts'
import { actorOf, loadProjectAccess, type ProjectAccess } from '../access'
import { badRequest } from '../http'
import type { Caller, ServiceDeps } from '../services/context'
import { DEFAULT_AGENT, loadAgents, type ChatAgentDef } from './agents/loader'
import type { ChatRuntime } from './llm'
import { loadMessages, NEW_CHAT_TITLE, openDraft, saveMessages, updateThread, type DraftRow, type ThreadRow } from './store'
import { buildToolset, toolAvailability, toolDefsFor } from './tools'
import type { ChatToolContext, ChatToolDef } from './tools/kit'

export interface ChatService {
  runtime: ChatRuntime
  agents: ChatAgentDef[]
  agent(name: string | null | undefined): ChatAgentDef
}

export function createChatService(runtime: ChatRuntime): ChatService {
  const agents = loadAgents()
  const byName = new Map(agents.map((a) => [a.name, a]))
  return {
    runtime,
    agents,
    agent: (name) => byName.get(name ?? DEFAULT_AGENT) ?? (byName.get(DEFAULT_AGENT) as ChatAgentDef),
  }
}

// ─── Turn context ───────────────────────────────────────────────────────────────────────────────

export interface TurnSetup {
  agent: ChatAgentDef
  access: ProjectAccess | null
  tools: (ChatToolInfo & { def: ChatToolDef })[]
}

/** The assistant, the picked project (checked) and the tools on offer. Shared by the tools popover and a turn. */
export async function setupTurn(
  deps: ServiceDeps,
  caller: Caller,
  svc: ChatService,
  args: { agent: string; projectKey: string | null; toolMode: ChatToolMode; disabledTools: readonly string[] },
): Promise<TurnSetup> {
  const agent = svc.agent(args.agent)
  const access = args.projectKey ? await loadProjectAccess(deps.db, caller.user, args.projectKey) : null
  const tools = toolAvailability(toolDefsFor(agent.tools, agent.draft), {
    actor: actorOf(caller.user),
    projectRole: access?.role,
    hasProject: access !== null,
    toolMode: args.toolMode,
    disabled: args.disabledTools,
  })
  return { agent, access, tools }
}

// ─── Prompt ─────────────────────────────────────────────────────────────────────────────────────

const PREAMBLE = `You are an assistant inside the SDLC platform, where teams plan stories and deliver them with AI agents that run in each developer's VS Code.

## The platform
- **Projects** have a short key (e.g. PAY) and members with a role: owner, lead, developer or viewer. Org admins can do everything everywhere.
- **Stories** (PAY-42) move draft → ready → in progress → in review → done. They have a priority, acceptance criteria, labels, a due date, one assignee and **tasks** (PAY-42/T1).
- **Workflows** are the steps a story goes through when a developer starts it: agent steps (an AI agent works), approval steps (a human signs off) and quality gates. Runs execute in the developer's VS Code harness (Claude Code, Codex, Copilot…) and are recorded on the platform.
- The **catalog** holds agents and skills: built-in, discovered in the project's repository, or defined on the platform.
- **Memory** keeps decisions, conventions and learnings that agents are given. **Repositories** are linked through the organization's Git connections.

## Ground rules
- Look things up with your tools; never invent ids, keys, slugs, numbers or people.
- Tools that change the platform show the user an Approve / Reject card. When the user has asked for a change, call the tool directly — the card is their confirmation, so don't also ask "shall I?" in prose. If they reject it, the result may carry the user's own reason — treat it as theirs (not a platform error), don't retry, and ask what to change.
- A result with \`ok: false\` means the call was refused or failed. Explain the message plainly; never claim it worked.
- Ask questions with \`ask_user\` (one call, all questions), not as a list in your reply.
- Never ask for, accept or repeat passwords, access tokens or other secrets.
- Be concise. Use markdown: short paragraphs, bullet lists, tables for several items, \`code\` for keys and slugs.`

function draftSection(draft: DraftRow | null, kind: DraftKind): string {
  const noun = DRAFT_KIND_LABELS[kind].noun
  if (!draft) return `## Current ${noun} draft\nNone yet. Start one with \`update_draft\` as soon as you know anything about what the user wants.`
  const mode = draft.targetId ? `Editing the existing ${noun} "${draft.targetLabel}".` : `Creating a new ${noun}.`
  const open = draft.openQuestions.length ? `Open questions: ${draft.openQuestions.join(' | ')}` : 'No open questions.'
  return [
    `## Current ${noun} draft`,
    `${mode} Status: ${draft.ready ? 'ready to submit' : 'in progress'}. ${open}`,
    'The user may have edited it in the Review screen — treat this as the latest version:',
    '```json',
    JSON.stringify(draft.data, null, 2).slice(0, 12_000),
    '```',
  ].join('\n')
}

export function buildSystemPrompt(args: {
  agent: ChatAgentDef
  caller: Caller
  access: ProjectAccess | null
  draft: DraftRow | null
  unavailable: { label: string; reason: string | null }[]
}): string {
  const { agent, caller, access } = args
  const project = access
    ? `The user is working in project **${access.project.key}** (${access.project.name}); their role there: ${access.role ?? 'org admin (not a member)'}. Tools default to this project.`
    : agent.scope === 'project'
      ? 'No project is selected. If the request needs one, ask which project with `ask_user` (offer keys from `list_projects` when you have it, or ask the user to pick one in the project chip).'
      : 'No project is selected; work across the projects the user can see.'
  const context = [
    '## Context',
    `Today is ${new Date().toISOString().slice(0, 10)}. The user is ${caller.user.displayName} (${caller.user.email}), org role: ${caller.user.orgRole === 'org_admin' ? 'org admin' : 'member'}.`,
    project,
    ...(args.unavailable.length
      ? [`Tools you can't use this turn (don't offer these actions; say who can): ${args.unavailable.map((t) => `${t.label} (${t.reason})`).join('; ')}.`]
      : []),
  ].join('\n')
  return [
    PREAMBLE,
    agent.name === DEFAULT_AGENT ? '' : `You are the **${agent.label}** specialist. For anything outside your scope, say which specialist can help — the user switches with the assistant picker.`,
    agent.prompt,
    context,
    agent.draft ? draftSection(args.draft, agent.draft) : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ─── Merging what the client sent ───────────────────────────────────────────────────────────────

type Part = UIMessage['parts'][number] & Record<string, unknown>
const isToolPart = (p: Part) => typeof p.type === 'string' && p.type.startsWith('tool-')
const toolNameOf = (p: Part) => (p.type as string).slice('tool-'.length)

function validClientOutput(tool: string, output: unknown): boolean {
  if (tool === 'ask_user') return AskUserOutputSchema.safeParse(output).success
  if (tool === 'handoff') return HandoffOutputSchema.safeParse(output).success
  return false
}

/**
 * The stored message with ONLY the changes a client may make: approval responses to pending approvals, and
 * outputs for the client-resolved tools (ask_user, handoff). Everything else in `incoming` is ignored, so a
 * client can't rewrite history or fake a server tool's result.
 */
export function mergeClientUpdate(stored: UIMessage, incoming: UIMessage): UIMessage {
  const byCall = new Map<string, Part>()
  for (const p of incoming.parts as Part[]) if (isToolPart(p) && typeof p.toolCallId === 'string') byCall.set(p.toolCallId, p)
  const parts = (stored.parts as Part[]).map((p): Part => {
    if (!isToolPart(p)) return p
    const next = byCall.get(p.toolCallId as string)
    if (!next) return p
    const approval = p.approval as { id: string } | undefined
    const nextApproval = next.approval as { id?: string; approved?: unknown; reason?: unknown } | undefined
    if (p.state === 'approval-requested' && next.state === 'approval-responded' && approval && nextApproval?.id === approval.id) {
      return {
        ...p,
        state: 'approval-responded',
        approval: {
          ...approval,
          approved: nextApproval.approved === true,
          ...(typeof nextApproval.reason === 'string' ? { reason: nextApproval.reason.slice(0, 500) } : {}),
        },
      } as Part
    }
    const tool = toolNameOf(p)
    if ((CLIENT_RESOLVED_TOOLS as readonly string[]).includes(tool) && p.state === 'input-available' && next.state === 'output-available') {
      if (validClientOutput(tool, next.output)) return { ...p, state: 'output-available', output: next.output } as Part
    }
    return p
  })
  return { ...stored, parts: parts as UIMessage['parts'] }
}

/** A new user message: text only (no files yet), size-capped. */
export function sanitizeUserMessage(incoming: UIMessage): UIMessage {
  const parts = (incoming.parts as Part[])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => ({ type: 'text' as const, text: (p.text as string).slice(0, 20_000) }))
  if (parts.length === 0 || parts.every((p) => !p.text.trim())) throw badRequest('The message is empty.')
  return { id: incoming.id, role: 'user', parts }
}

const titleFrom = (m: UIMessage): string => {
  const text = (m.parts as Part[]).filter((p) => p.type === 'text').map((p) => p.text as string).join(' ').replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || NEW_CHAT_TITLE
}

/** What the user sees when the model call fails — actionable for whoever configures the API, no secrets. */
export function describeModelError(error: unknown): string {
  const status = (error as { statusCode?: unknown })?.statusCode
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error)
  if (status === 401 || status === 403) return 'Azure OpenAI refused the request — check AZURE_OPENAI_API_KEY for the API.'
  if (status === 404) return 'The model deployment was not found — check CHAT_MODELS / AZURE_DEPLOYMENT_NAME for the API.'
  if (status === 429) return 'Azure OpenAI is rate-limiting requests. Try again in a moment.'
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|Cannot connect/i.test(text)) return 'Could not reach Azure OpenAI — check AZURE_OPENAI_BASE_URL for the API.'
  if (/content.?filter|content management policy/i.test(text)) return 'Azure OpenAI’s content filter blocked this answer. Rephrase and try again.'
  return 'The assistant hit an error. Try again.'
}

// ─── The turn ───────────────────────────────────────────────────────────────────────────────────

export interface TurnArgs {
  thread: ThreadRow
  message: UIMessage
  agent: string
  projectKey: string | null
  model: string | null
  toolMode: ChatToolMode
  disabledTools: string[]
}

/**
 * Run one turn. Everything that can be refused (permissions, a bad message) happens BEFORE `start()` is called,
 * so it still becomes a normal JSON error; `start()` takes over the raw response and the answer streams into it.
 * The history is persisted when the stream ends (also when the user stops it).
 */
export async function runTurn(
  deps: ServiceDeps,
  caller: Caller,
  svc: ChatService,
  args: TurnArgs,
  start: () => ServerResponse,
  log: ChatToolContext['log'],
): Promise<void> {
  const setup = await setupTurn(deps, caller, svc, args)
  const { agent, access } = setup

  // History + the client's message.
  const history = await loadMessages(deps.db, args.thread.id)
  const at = history.findIndex((m) => m.id === args.message.id)
  let messages: UIMessage[]
  let changed: UIMessage
  if (at >= 0) {
    if (args.message.role !== 'assistant') throw badRequest('That message was already sent.')
    changed = mergeClientUpdate(history[at], args.message)
    messages = [...history.slice(0, at), changed, ...history.slice(at + 1)]
  } else {
    if (args.message.role !== 'user') throw badRequest('Only a new user message can be added.')
    changed = sanitizeUserMessage(args.message)
    messages = [...history, changed]
  }
  await saveMessages(deps.db, args.thread.id, [changed])
  await updateThread(deps.db, args.thread.id, {
    agent: agent.name,
    projectId: access?.project.id ?? null,
    model: args.model,
    ...(args.thread.title === NEW_CHAT_TITLE && changed.role === 'user' ? { title: titleFrom(changed) } : {}),
  })

  const ctx: ChatToolContext = {
    deps,
    caller: { user: caller.user, via: `${caller.via}:chat` },
    threadId: args.thread.id,
    projectKey: access?.project.key ?? null,
    agent: agent.name,
    log,
  }
  const available = setup.tools.filter((t) => t.available).map((t) => t.def)
  const { tools, approval } = buildToolset(available, ctx, args.toolMode)
  const draft = agent.draft ? await openDraft(deps.db, args.thread.id, agent.draft) : null
  const system = buildSystemPrompt({
    agent,
    caller,
    access,
    draft,
    unavailable: setup.tools.filter((t) => !t.available && t.reason !== 'Turned off').map((t) => ({ label: t.label, reason: t.reason })),
  })

  const { model, info } = svc.runtime.model(args.model)
  const modelMessages = await convertToModelMessages(messages, {
    tools,
    ignoreIncompleteToolCalls: true,
    convertDataPart: (part) =>
      part.type === DRAFT_SUBMITTED_PART
        ? { type: 'text', text: `[The user reviewed and submitted the draft: ${(part.data as { label?: string }).label ?? 'done'}.]` }
        : undefined,
  })

  const res = start()
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abort.abort()
  })
  let lastStepUsage: LanguageModelUsage | undefined
  const result = streamText({
    model,
    system,
    messages: modelMessages,
    tools,
    toolApproval: approval,
    experimental_toolApprovalSecret: svc.runtime.approvalSecret,
    stopWhen: isStepCount(Math.min(agent.maxSteps, svc.runtime.maxSteps)),
    abortSignal: abort.signal,
    onStepFinish: (step) => {
      lastStepUsage = step.usage
    },
    onError: ({ error }) => log.error({ err: error }, 'chat model error'),
  })

  await result.pipeUIMessageStreamToResponse<UIMessage>(res, {
    originalMessages: messages,
    generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
    messageMetadata: ({ part }): ChatMessageMetadata | undefined => {
      if (part.type === 'start') return { model: info.id, createdAt: new Date().toISOString() }
      if (part.type === 'finish') {
        return {
          model: info.id,
          usage: {
            // The last step's input is what the context window holds now.
            inputTokens: lastStepUsage?.inputTokens ?? undefined,
            outputTokens: lastStepUsage?.outputTokens ?? undefined,
            totalTokens: lastStepUsage?.totalTokens ?? undefined,
          },
        }
      }
      return undefined
    },
    onError: (error) => {
      log.error({ err: error }, 'chat stream error')
      return describeModelError(error)
    },
    onEnd: async ({ responseMessage }) => {
      try {
        await saveMessages(deps.db, args.thread.id, [responseMessage])
      } catch (err) {
        log.error({ err }, 'could not save chat messages')
      }
    },
  })
}
