// The single fetch wrapper. Every service call goes through here: same-origin /api/v1 (the proxy adds the
// caller's identity), JSON in and out, API errors turned into AppError, and every response validated
// against its contract schema before it reaches a component.

import type { ZodType, ZodTypeDef } from 'zod'
import { ApiErrorSchema } from '@sdlc/contracts'
import { AppError } from '@/appError'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface RequestOptions<Body> {
  method?: Method
  body?: Body
}

async function send<Body>(path: string, options: RequestOptions<Body>): Promise<Response> {
  try {
    return await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers: options.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    })
  } catch (err) {
    throw new AppError('Cannot reach the server', err instanceof Error ? err.message : undefined)
  }
}

/** Raw JSON off the wire. `unknown` only here, and it is schema-validated before anything else sees it. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function failure(res: Response, path: string): Promise<AppError> {
  const parsed = ApiErrorSchema.safeParse(await readJson(res))
  return parsed.success
    ? new AppError(parsed.data.message, path, res.status, parsed.data.error, parsed.data.details)
    : new AppError(`Request failed (${res.status})`, path, res.status)
}

/** Call the API and validate the response with `schema`. Throws AppError (with the HTTP status) on failure. */
export async function apiRequest<T, Input, Body = never>(
  path: string,
  schema: ZodType<T, ZodTypeDef, Input>,
  options: RequestOptions<Body> = {},
): Promise<T> {
  const res = await send(path, options)
  if (!res.ok) throw await failure(res, path)
  const result = schema.safeParse(await readJson(res))
  if (!result.success) {
    throw new AppError('Unexpected response from the server', result.error.issues[0]?.message, res.status)
  }
  return result.data
}

/** For calls whose response body isn't needed. */
export async function apiCommand<Body = never>(path: string, options: RequestOptions<Body>): Promise<void> {
  const res = await send(path, options)
  if (!res.ok) throw await failure(res, path)
}
