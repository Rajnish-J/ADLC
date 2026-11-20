import type { ApiError } from '@sdlc/contracts'

/**
 * The one error type the web app throws and catches. `status` is the HTTP status when it came from the API;
 * `code` and `details` are the API's machine-readable error (e.g. `commit_conflict` with the conflicting files).
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly description?: string,
    readonly status?: number,
    readonly code?: string,
    readonly details?: ApiError['details'],
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function toAppError(err: Error | AppError | string | null | undefined, fallback: string): AppError {
  if (err instanceof AppError) return err
  return new AppError(fallback, err instanceof Error ? err.message : (err ?? undefined))
}
