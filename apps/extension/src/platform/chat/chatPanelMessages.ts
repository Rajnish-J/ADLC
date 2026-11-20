// Messages between the Chat panel's webview and the extension host. The webview never talks to the network: the
// host makes every API call with the platform connection's identity, and streams chat answers back in chunks.

import type { DraftRef, PlatformEvent } from '@sdlc/contracts'

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export type ChatToHost =
  | { type: 'ready' }
  /** A plain API call (config, assistants, threads, drafts, projects…). Only allow-listed paths are served. */
  | { type: 'request'; requestId: string; method: ApiMethod; path: string; body?: unknown }
  /** Start a streamed turn: POST /chat with this body. */
  | { type: 'send'; requestId: string; body: unknown }
  | { type: 'abort'; requestId: string }
  /** Open what a submitted draft created: a story panel, or the web page. */
  | { type: 'openRef'; ref: DraftRef }
  | { type: 'signIn' }

export type HostToChat =
  | { type: 'init'; signedIn: boolean; userName: string | null; webUrl: string }
  | { type: 'response'; requestId: string; ok: boolean; status: number; data: unknown; message: string | null }
  /** Raw text of the server-sent-event stream, in arrival order. */
  | { type: 'chunk'; requestId: string; text: string }
  | { type: 'end'; requestId: string }
  | { type: 'streamError'; requestId: string; status: number; message: string }
  | { type: 'platformEvent'; event: PlatformEvent }

/** API paths the webview may call through the host (anything else is refused). */
export const ALLOWED_PATHS: { method: ApiMethod; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/chat\/(config|agents|threads)$/ },
  { method: 'GET', pattern: /^\/chat\/tools\?[\w=&%.-]*$/ },
  { method: 'POST', pattern: /^\/chat\/threads$/ },
  { method: 'GET', pattern: /^\/chat\/threads\/[0-9a-f-]{36}(\/drafts)?$/ },
  { method: 'PATCH', pattern: /^\/chat\/threads\/[0-9a-f-]{36}$/ },
  { method: 'DELETE', pattern: /^\/chat\/threads\/[0-9a-f-]{36}$/ },
  { method: 'GET', pattern: /^\/chat\/drafts\/[0-9a-f-]{36}$/ },
  { method: 'PATCH', pattern: /^\/chat\/drafts\/[0-9a-f-]{36}$/ },
  { method: 'POST', pattern: /^\/chat\/drafts\/[0-9a-f-]{36}\/(submit|discard)$/ },
  { method: 'GET', pattern: /^\/projects$/ },
  { method: 'GET', pattern: /^\/projects\/[A-Za-z0-9]{1,20}\/agents$/ },
  { method: 'GET', pattern: /^\/git-connections$/ },
]

export function isAllowed(method: ApiMethod, path: string): boolean {
  return ALLOWED_PATHS.some((p) => p.method === method && p.pattern.test(path))
}
