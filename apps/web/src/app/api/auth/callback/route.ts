// Microsoft sign-in, step 2 (the redirect URI registered in Entra ID): check the state, redeem the code with the
// PKCE verifier, keep the tokens in the encrypted session cookie and continue to where the user was going.

import { NextResponse } from 'next/server'
import { AUTH_MODE, callbackUrl, publicOrigin } from '@/server/authConfig'
import { saveSession, takeSignInFlow } from '@/server/entraSession'
import { completeSignIn } from '@/server/msal'
import type { SignInError } from '@/types/session/session.types'

export const dynamic = 'force-dynamic'

function toLogin(req: Request, error: SignInError): NextResponse {
  const url = new URL('/login', publicOrigin(req))
  url.searchParams.set('error', error)
  return NextResponse.redirect(url)
}

export async function GET(req: Request): Promise<Response> {
  if (AUTH_MODE !== 'entra') return NextResponse.redirect(new URL('/login', publicOrigin(req)))
  const params = new URL(req.url).searchParams
  const flow = await takeSignInFlow()

  const entraError = params.get('error')
  if (entraError) {
    console.warn(`[auth] Entra sign-in returned ${entraError}: ${params.get('error_description') ?? ''}`)
    return toLogin(req, entraError === 'access_denied' ? 'cancelled' : 'signin_failed')
  }

  const code = params.get('code')
  if (!flow || !code || params.get('state') !== flow.state) return toLogin(req, 'expired_request')

  try {
    await saveSession(await completeSignIn(code, flow.codeVerifier, callbackUrl(req)))
  } catch (err) {
    console.error('[auth] Could not complete Microsoft sign-in:', err instanceof Error ? err.message : err)
    return toLogin(req, 'signin_failed')
  }
  return NextResponse.redirect(new URL(flow.returnTo, publicOrigin(req)))
}
