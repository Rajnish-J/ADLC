// Personal access tokens: how the VS Code extension (or a script) calls the API as you when the web app signs people
// in with Microsoft. Created on the web (Settings → VS Code), sent as `Authorization: Bearer sdlc_pat_…`. The API
// stores only a hash; the token itself is shown once, when it is created.

import { z } from 'zod'

/** Every token starts with this, so the API can tell it from a Microsoft access token. */
export const ACCESS_TOKEN_PREFIX = 'sdlc_pat_'

export const ACCESS_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const

export function isAccessToken(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(ACCESS_TOKEN_PREFIX))
}

export const AccessTokenSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** The token's first characters, to tell tokens apart. */
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** Null: never expires. */
  expiresAt: z.string().nullable(),
})
export type AccessToken = z.infer<typeof AccessTokenSchema>

export const CreateAccessTokenInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the token a name.').max(80),
  /** Days until it stops working; null for never. */
  expiresInDays: z
    .union([z.literal(30), z.literal(90), z.literal(365), z.null()])
    .default(90),
})
export type CreateAccessTokenInput = z.input<typeof CreateAccessTokenInputSchema>

export const CreatedAccessTokenSchema = z.object({
  /** The token itself — returned only here, never again. */
  token: z.string(),
  accessToken: AccessTokenSchema,
})
export type CreatedAccessToken = z.infer<typeof CreatedAccessTokenSchema>
