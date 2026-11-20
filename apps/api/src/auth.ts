// Request identity, by AUTH_MODE:
// - `dev`: the caller names a seeded user in the `x-dev-user` header (the extension) or the `sdlc_dev_user` cookie
//   (the web app). loadConfig() refuses this mode in production.
// - `entra`: a Microsoft Entra ID access token in `Authorization: Bearer …` (the web app's proxy attaches the one MSAL
//   got at sign-in). The user is found by Entra object id; on first sign-in an existing directory entry with the same
//   email is linked, otherwise the person joins the organization as a plain member (no project access until added).
// In both modes a personal access token (`Authorization: Bearer sdlc_pat_…`, created on the web) identifies its user —
// that is how the VS Code extension signs in when the web uses Microsoft sign-in.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { CLIENT_HEADER, isAccessToken, type ClientKind, type OrgRole } from '@sdlc/contracts'
import type { Config } from './config'
import type { Db } from './db/client'
import { organizations, users } from './db/schema'
import { bearerToken, createEntraVerifier, type EntraIdentity, type EntraTokenVerifier } from './entra'
import { forbidden, isUniqueViolation, unauthorized } from './http'
import { resolveTokenUser } from './services/accessTokens'

export interface AuthUser {
  id: string
  orgId: string
  email: string
  displayName: string
  orgRole: OrgRole
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser
    /** Which client made the request — recorded in the audit log. */
    client: ClientKind | 'api'
    /** How the caller proved who they are. */
    authMethod: AuthMethod
  }
}

export type AuthMethod = 'entra' | 'token' | 'dev' | 'none'

export const DEV_USER_HEADER = 'x-dev-user'
export const DEV_USER_COOKIE = 'sdlc_dev_user'

/** Routes that need no identity. */
const PUBLIC_PATHS = new Set(['/healthz', '/api/v1/dev/users'])

const AUTH_USER_COLUMNS = {
  id: users.id,
  orgId: users.orgId,
  email: users.email,
  displayName: users.displayName,
  orgRole: users.orgRole,
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

function devIdentity(req: FastifyRequest): string | undefined {
  const header = req.headers[DEV_USER_HEADER]
  const fromHeader = Array.isArray(header) ? header[0] : header
  return (fromHeader || cookieValue(req.headers.cookie, DEV_USER_COOKIE))?.trim() || undefined
}

function clientKind(req: FastifyRequest): ClientKind | 'api' {
  const v = req.headers[CLIENT_HEADER]
  return v === 'web' || v === 'extension' ? v : 'api'
}

async function resolveDevUser(db: Db, req: FastifyRequest): Promise<AuthUser> {
  const email = devIdentity(req)
  if (!email) throw unauthorized('Sign in required: choose a dev user.')
  const [row] = await db
    .select(AUTH_USER_COLUMNS)
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
    .limit(1)
  if (!row) throw unauthorized(`Unknown dev user "${email}". Run the seed, or pick a user from /api/v1/dev/users.`)
  return row
}

async function userByOid(db: Db, oid: string): Promise<AuthUser | undefined> {
  const [row] = await db.select(AUTH_USER_COLUMNS).from(users).where(eq(users.entraOid, oid)).limit(1)
  return row
}

/** The platform user behind an Entra identity — linked or created on first sign-in. */
export async function resolveEntraUser(db: Db, id: EntraIdentity): Promise<AuthUser> {
  const linked = await userByOid(db, id.oid)
  if (linked) return linked

  // First Entra sign-in of someone already in the directory (added by email): link the identity to that entry.
  const byEmail = await db
    .select(AUTH_USER_COLUMNS)
    .from(users)
    .where(and(eq(sql`lower(${users.email})`, id.email.toLowerCase()), isNull(users.entraOid)))
    .limit(2)
  if (byEmail.length > 1) throw forbidden('Your email matches more than one account. Ask an org admin to resolve it.')
  if (byEmail.length === 1) {
    const [row] = await db
      .update(users)
      .set({ entraOid: id.oid })
      .where(and(eq(users.id, byEmail[0].id), isNull(users.entraOid)))
      .returning(AUTH_USER_COLUMNS)
    const user = row ?? (await userByOid(db, id.oid))
    if (user) return user
    throw forbidden('This account is already linked to another Microsoft identity.')
  }

  // Someone new joins the organization as a plain member — they see no project until someone adds them.
  const orgs = await db.select({ id: organizations.id }).from(organizations).limit(2)
  if (orgs.length !== 1) throw forbidden('Your account is not set up on the platform yet. Ask an org admin to add you.')
  try {
    const [created] = await db
      .insert(users)
      .values({ orgId: orgs[0].id, email: id.email, displayName: id.displayName, entraOid: id.oid })
      .returning(AUTH_USER_COLUMNS)
    return created
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // A parallel first request created it, or the email belongs to an entry linked to a different identity.
    const user = await userByOid(db, id.oid)
    if (user) return user
    throw forbidden('An account with your email is already linked to another Microsoft identity.')
  }
}

export function registerAuth(app: FastifyInstance, db: Db, config: Config, verifier?: EntraTokenVerifier): void {
  app.decorateRequest('user', null as unknown as AuthUser)
  app.decorateRequest('client', 'api')
  app.decorateRequest('authMethod', 'none')

  const verifyEntra =
    config.AUTH_MODE === 'entra'
      ? (verifier ??
        createEntraVerifier({
          tenantId: config.ENTRA_TENANT_ID ?? '',
          clientId: config.ENTRA_CLIENT_ID ?? '',
          extraAudiences: config.ENTRA_API_AUDIENCE?.split(',').map((a) => a.trim()).filter(Boolean),
        }))
      : undefined

  app.addHook('onRequest', async (req) => {
    req.client = clientKind(req)
    const path = req.url.split('?')[0]
    if (PUBLIC_PATHS.has(path)) return
    // Service-to-service calls (the orchestrator) carry the internal token instead; their routes check it.
    if (path.startsWith('/internal/')) return

    const token = bearerToken(req.headers.authorization)
    if (token && isAccessToken(token)) {
      req.user = await resolveTokenUser(db, token)
      req.authMethod = 'token'
      return
    }
    if (!verifyEntra) {
      req.user = await resolveDevUser(db, req)
      req.authMethod = 'dev'
      return
    }
    if (!token) throw unauthorized('Sign in required.')
    req.user = await resolveEntraUser(db, await verifyEntra(token))
    req.authMethod = 'entra'
  })
}
