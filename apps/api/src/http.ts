// HTTP errors and input parsing shared by every route.

import type { ZodType, ZodTypeDef } from 'zod'

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details)
export const unauthorized = (message = 'Sign in required.') => new HttpError(401, 'unauthorized', message)
export const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message)
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found.`)
export const conflict = (message: string) => new HttpError(409, 'conflict', message)

/** Validate `data` against a contract schema; a failure becomes a 400 with the zod issues as details. */
export function parse<Out, In>(schema: ZodType<Out, ZodTypeDef, In>, data: unknown): Out {
  const result = schema.safeParse(data ?? {})
  if (!result.success) {
    const first = result.error.issues[0]
    const where = first?.path.length ? `${first.path.join('.')}: ` : ''
    throw badRequest(`${where}${first?.message ?? 'Invalid input.'}`, result.error.issues)
  }
  return result.data
}

/** Postgres unique_violation. Drizzle wraps driver errors (DrizzleQueryError), so the pg error may be a `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') return true
  }
  return false
}
