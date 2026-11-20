// The chat tool kit. Every tool is a thin wrapper over an existing service, called in-process as the signed-in
// user — so permission checks, audit (`via: <client>:chat`) and live events are exactly those of the API.
// Tools never throw at the model: a refused or failed call comes back as `{ ok: false, error }` so the
// assistant can explain it.

import { tool, type Tool } from 'ai'
import type { z, ZodTypeAny } from 'zod'
import type { Permission, User } from '@sdlc/contracts'
import { badRequest, HttpError } from '../../http'
import type { Caller, ServiceDeps } from '../../services/context'

/** read: looks things up. write: changes the platform (always needs the user's approval). */
export type ChatToolAccess = 'read' | 'write'

/**
 * draft: writes only to this chat's draft (no approval — the user submits the draft themselves).
 * interaction: answered by the user in the UI (no server execute).
 */
export type ChatToolKind = 'platform' | 'draft' | 'interaction'

export interface ChatToolContext {
  deps: ServiceDeps
  caller: Caller
  threadId: string
  /** The project picked in the chat; tools default to it. */
  projectKey: string | null
  /** The assistant running this turn. */
  agent: string
  log: { error: (obj: unknown, msg?: string) => void }
}

export interface ChatToolDef<S extends ZodTypeAny = ZodTypeAny> {
  name: string
  /** Short human label for the Tools popover and approval cards. */
  label: string
  access: ChatToolAccess
  kind?: ChatToolKind
  /**
   * What the user must hold. Project permissions are checked against their role in the picked project
   * (the service checks again on every call); `project.create` / `org.manage` are org-level.
   */
  permission?: Permission
  description: string
  input: S
  /** Absent for interaction tools (the client supplies the output). */
  execute?: (ctx: ChatToolContext, input: z.infer<S>) => Promise<unknown>
}

/** Typed while you write the tool (input inferred from the schema); erased for the registry. */
export function defineChatTool<S extends ZodTypeAny>(def: ChatToolDef<S>): ChatToolDef {
  return def as unknown as ChatToolDef
}

export interface ToolFailure {
  ok: false
  status?: number
  error: string
}

export function toAiTool(def: ChatToolDef, ctx: ChatToolContext): Tool {
  if (!def.execute) return tool({ description: def.description, inputSchema: def.input })
  const run = def.execute
  return tool({
    description: def.description,
    inputSchema: def.input,
    execute: async (input: unknown): Promise<unknown> => {
      try {
        return await run(ctx, input)
      } catch (err) {
        if (err instanceof HttpError) return { ok: false, status: err.statusCode, error: err.message } satisfies ToolFailure
        ctx.log.error({ err, tool: def.name }, 'chat tool failed')
        return { ok: false, error: 'Something went wrong running this tool.' } satisfies ToolFailure
      }
    },
  })
}

/** The project a tool acts on: the one it names, else the one picked in the chat. */
export function projectOf(ctx: ChatToolContext, named: string | null | undefined): string {
  const key = (named ?? ctx.projectKey)?.trim().toUpperCase()
  if (!key) throw badRequest('No project is selected. Ask the user which project (or have them pick one in the project chip above the message box).')
  return key
}

/** `{ id, name, email }` — never more about a person. */
export const person = (u: Pick<User, 'id' | 'displayName' | 'email'> | null | undefined) =>
  u ? { id: u.id, name: u.displayName, email: u.email } : null

/** Cut long text so one tool result can't flood the context window. */
export function clip(text: string | null | undefined, max = 4000): string {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text
}

/** Shared input field: which project. */
export const PROJECT_FIELD_DESCRIPTION = 'Project key (e.g. "PAY"); null = the project selected in the chat.'
