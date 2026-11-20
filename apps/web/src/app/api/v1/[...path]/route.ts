// Same-origin proxy to the platform API. The browser never calls the API directly: this handler attaches
// the caller's identity server-side (the Entra access token from the encrypted session cookie, renewed when
// close to expiry — it never reaches browser JavaScript; or the dev-user cookie in local development) and
// streams the response back — including the live-event SSE stream.

import { cookies } from 'next/headers'
import { CLIENT_HEADER } from '@sdlc/contracts'
import { API_URL, DEV_USER_COOKIE } from '@/server/apiConfig'
import { AUTH_MODE } from '@/server/authConfig'
import { currentAccessToken } from '@/server/entraSession'

export const dynamic = 'force-dynamic'

const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'last-event-id']
// x-vercel-ai-ui-message-stream marks the chat's streamed answers (AI SDK UI message stream protocol);
// content-disposition makes downloads (the project profile as Markdown) save as a file.
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'content-disposition', 'x-vercel-ai-ui-message-stream']

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params
  const search = new URL(req.url).search
  const target = `${API_URL}/api/v1/${path.map(encodeURIComponent).join('/')}${search}`

  const headers = new Headers({ [CLIENT_HEADER]: 'web' })
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (AUTH_MODE === 'entra') {
    const token = await currentAccessToken()
    if (!token) return Response.json({ error: 'unauthorized', message: 'Sign in required.' }, { status: 401 })
    headers.set('authorization', `Bearer ${token}`)
  } else {
    const devUser = (await cookies()).get(DEV_USER_COOKIE)?.value
    if (devUser) headers.set('x-dev-user', devUser)
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
      cache: 'no-store',
      signal: req.signal,
    })
  } catch {
    return Response.json(
      { error: 'api_unreachable', message: `The platform API (${API_URL}) is not reachable. Start it with: npm run dev:api` },
      { status: 502 },
    )
  }

  const out = new Headers()
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) out.set(name, value)
  }
  if (upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
    out.set('cache-control', 'no-cache, no-transform')
    out.set('x-accel-buffering', 'no')
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE }
