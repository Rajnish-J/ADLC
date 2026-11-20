// Personal access tokens: create (shown once), list, revoke — and resolve the user behind one on each request.
// Only a SHA-256 of the token is stored. A token is refused once revoked or past its expiry, and stops working if its
// user is removed (the row cascades).

import { createHash, randomBytes } from 'crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { ACCESS_TOKEN_PREFIX, type AccessToken, type CreateAccessTokenInput, CreateAccessTokenInputSchema, type CreatedAccessToken } from '@sdlc/contracts'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import type { Db } from '../db/client'
import { personalAccessTokens, users } from '../db/schema'
import { notFound, unauthorized } from '../http'
import type { Caller } from './context'

/** How many characters of the token are kept to tell tokens apart (`sdlc_pat_` + 4). */
const PREFIX_LENGTH = ACCESS_TOKEN_PREFIX.length + 4
/** `last_used_at` is written at most this often per token. */
const LAST_USED_RESOLUTION_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

export const INVALID_ACCESS_TOKEN = 'This access token is invalid, expired or revoked. Create a new one in the web app under Settings → VS Code.'

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function generateAccessToken(): string {
  return `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** Whether a stored token may still be used at `now`. */
export function tokenUsable(row: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()): boolean {
  return !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > now.getTime())
}

type TokenRow = typeof personalAccessTokens.$inferSelect

function toAccessToken(row: TokenRow): AccessToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }
}

/** The caller's tokens that haven't been revoked (expired ones included, so people see why one stopped working). */
export async function listAccessTokens(db: Db, user: AuthUser): Promise<AccessToken[]> {
  const rows = await db
    .select()
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.userId, user.id), isNull(personalAccessTokens.revokedAt)))
    .orderBy(desc(personalAccessTokens.createdAt))
  return rows.map(toAccessToken)
}

export async function createAccessToken(db: Db, caller: Caller, input: CreateAccessTokenInput): Promise<CreatedAccessToken> {
  const { name, expiresInDays } = CreateAccessTokenInputSchema.parse(input)
  const token = generateAccessToken()
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(personalAccessTokens)
      .values({
        userId: caller.user.id,
        name,
        tokenHash: hashAccessToken(token),
        prefix: token.slice(0, PREFIX_LENGTH),
        expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * DAY_MS) : null,
      })
      .returning()
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      actorUserId: caller.user.id,
      action: 'access_token.created',
      resourceType: 'access_token',
      resourceId: created.id,
      data: { name, expiresAt: created.expiresAt?.toISOString() ?? null },
      via: caller.via,
    })
    return created
  })
  return { token, accessToken: toAccessToken(row) }
}

export async function revokeAccessToken(db: Db, caller: Caller, id: string): Promise<{ ok: true }> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.userId, caller.user.id), isNull(personalAccessTokens.revokedAt)))
      .returning({ id: personalAccessTokens.id, name: personalAccessTokens.name })
    if (!row) throw notFound('Access token')
    await writeAudit(tx, {
      orgId: caller.user.orgId,
      actorUserId: caller.user.id,
      action: 'access_token.revoked',
      resourceType: 'access_token',
      resourceId: row.id,
      data: { name: row.name },
      via: caller.via,
    })
  })
  return { ok: true }
}

/** The user a `sdlc_pat_…` token belongs to; 401 when it is unknown, revoked or expired. */
export async function resolveTokenUser(db: Db, token: string): Promise<AuthUser> {
  const [row] = await db
    .select({
      tokenId: personalAccessTokens.id,
      revokedAt: personalAccessTokens.revokedAt,
      expiresAt: personalAccessTokens.expiresAt,
      lastUsedAt: personalAccessTokens.lastUsedAt,
      id: users.id,
      orgId: users.orgId,
      email: users.email,
      displayName: users.displayName,
      orgRole: users.orgRole,
    })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .where(eq(personalAccessTokens.tokenHash, hashAccessToken(token)))
    .limit(1)
  const now = new Date()
  if (!row || !tokenUsable(row, now)) throw unauthorized(INVALID_ACCESS_TOKEN)

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    // Best effort: a failed bookkeeping write never fails the request.
    await db
      .update(personalAccessTokens)
      .set({ lastUsedAt: now })
      .where(eq(personalAccessTokens.id, row.tokenId))
      .catch(() => undefined)
  }
  return { id: row.id, orgId: row.orgId, email: row.email, displayName: row.displayName, orgRole: row.orgRole }
}
