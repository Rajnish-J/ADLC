// The gateway's client for the orchestrator service (services/orchestrator, Python FastAPI + LangGraph), which owns
// the workflow and agent/skill catalog and drives platform runs. Every call carries the shared internal token and the
// signed-in user's id; the orchestrator re-checks the user's project access itself.
//
// Errors come back in the gateway's own shape ({error, message, details}) and are rethrown as HttpError with the
// same status, code and message — so routes, the web app, the extension and the chat assistant's tools see exactly
// what the TypeScript services used to return.

import type { ZodType, ZodTypeDef } from 'zod'
import { HttpError } from '../http'

export const INTERNAL_TOKEN_HEADER = 'x-sdlc-internal-token'
const USER_HEADER = 'x-sdlc-user-id'
const VIA_HEADER = 'x-sdlc-via'

export interface OrchestratorCaller {
  user: { id: string }
  via?: string
}

export interface CallOptions {
  body?: unknown
  query?: Record<string, string | number | undefined | null>
  /** Long-polls need longer than the default. */
  timeoutMs?: number
}

const unavailable = () =>
  new HttpError(503, 'orchestrator_unavailable', 'The orchestrator service is not reachable. Start it with `npm run dev:orchestrator`.')

export class OrchestratorClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  /** Call the orchestrator as `caller` and validate the response with a contract schema. */
  async call<Out>(
    caller: OrchestratorCaller,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: ZodType<Out, ZodTypeDef, unknown> | null,
    options: CallOptions = {},
  ): Promise<Out> {
    const url = new URL(path, this.baseUrl)
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    const headers: Record<string, string> = {
      [INTERNAL_TOKEN_HEADER]: this.token,
      [USER_HEADER]: caller.user.id,
      [VIA_HEADER]: caller.via ?? 'api',
      accept: 'application/json',
    }
    const hasBody = options.body !== undefined && method !== 'GET'
    if (hasBody) headers['content-type'] = 'application/json'

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs),
      })
    } catch {
      throw unavailable()
    }
    const text = await res.text()
    const json: unknown = text ? safeJson(text) : undefined
    if (!res.ok) {
      const err = (json ?? {}) as { error?: string; message?: string; details?: unknown }
      throw new HttpError(res.status, err.error ?? 'internal', err.message ?? 'Something went wrong.', err.details)
    }
    if (!schema) return json as Out
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new HttpError(502, 'bad_gateway', `The orchestrator answered ${method} ${path} with an unexpected shape.`, parsed.error.issues)
    }
    return parsed.data
  }

  /** Liveness for Admin › System. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(new URL('/healthz', this.baseUrl), { signal: AbortSignal.timeout(3_000) })
      const body = (await res.json().catch(() => ({}))) as { runtime?: string }
      return { ok: res.ok, detail: res.ok ? `runtime ${body.runtime ?? 'unknown'}` : `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

let instance: OrchestratorClient | null = null

/** Set once at startup (buildApp). Tests may swap in their own. */
export function configureOrchestrator(client: OrchestratorClient | null): void {
  instance = client
}

export function orchestrator(): OrchestratorClient {
  if (!instance) throw unavailable()
  return instance
}

/** `/api/v1/projects/<key>/...` with every dynamic segment encoded. */
export function projectPath(key: string, ...rest: (string | number)[]): string {
  return ['/api/v1/projects', encodeURIComponent(key), ...rest.map((p) => encodeURIComponent(String(p)))].join('/')
}
