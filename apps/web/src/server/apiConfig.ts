// Imported only by route handlers (server code).

/** Where the platform API runs. Server-side only — the browser always talks to this app's /api/v1 proxy. */
export const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '')

/** httpOnly cookie naming the dev user (local development sign-in; replaced by Entra ID later). */
export const DEV_USER_COOKIE = 'sdlc_dev_user'
