// Microsoft sign-in, step 1: remember the state + PKCE verifier (encrypted cookie) and send the browser to Entra ID.

import { NextResponse } from 'next/server'
import { AUTH_MODE, callbackUrl, publicOrigin } from '@/server/authConfig'
import { safeReturnTo, saveSignInFlow } from '@/server/entraSession'
import { beginSignIn } from '@/server/msal'
import type { SignInError } from '@/types/session/session.types'

export const dynamic = 'force-dynamic'

function toLogin(req: Request, error?: SignInError): NextResponse {
  const url = new URL('/login', publicOrigin(req))
  if (error) url.searchParams.set('error', error)
  return NextResponse.redirect(url)
}

export async function GET(req: Request): Promise<Response> {
  if (AUTH_MODE !== 'entra') return toLogin(req)
  try {
    const returnTo = safeReturnTo(new URL(req.url).searchParams.get('returnTo'))
    const { url, flow } = await beginSignIn(callbackUrl(req), returnTo)
    await saveSignInFlow(flow)
    return NextResponse.redirect(url)
  } catch (err) {
    console.error('[auth] Cannot start Microsoft sign-in:', err instanceof Error ? err.message : err)
    return toLogin(req, 'not_configured')
  }
}
