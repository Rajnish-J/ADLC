// Encrypted, httpOnly cookies for server-side secrets (Entra tokens, the in-flight sign-in's PKCE verifier).
// AES-256-GCM with a key derived from AUTH_SESSION_SECRET: the browser holds the cookie but can neither read nor
// alter it. Values larger than one cookie allows (an access + refresh token pair is ~4–6 KB) are split into
// numbered chunks: `<name>.0`, `<name>.1`, …

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'
import { cookies } from 'next/headers'
import type { ZodType, ZodTypeDef } from 'zod'
import { entraConfig } from './authConfig'

type CookieStore = Awaited<ReturnType<typeof cookies>>

const VERSION = 'v1'
/** Below the ~4096-byte per-cookie limit, leaving room for the name and attributes. */
const CHUNK_SIZE = 3800
const MAX_CHUNKS = 5

export interface SealedCookieOptions {
  maxAgeSeconds: number
  path?: string
}

let cachedKey: { secret: string; key: Buffer } | undefined

function key(): Buffer {
  const secret = entraConfig().sessionSecret
  if (cachedKey?.secret !== secret) {
    cachedKey = { secret, key: Buffer.from(hkdfSync('sha256', secret, 'sdlc-web', 'sealed-cookie-v1', 32)) }
  }
  return cachedKey.key
}

function seal(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
}

function unseal(sealed: string): string | undefined {
  const [version, iv, tag, body] = sealed.split('.')
  if (version !== VERSION || !iv || !tag || !body) return undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    // Tampered with, or sealed with a previous secret.
    return undefined
  }
}

function chunkName(name: string, index: number): string {
  return `${name}.${index}`
}

export async function writeSealedCookie<T>(name: string, value: T, options: SealedCookieOptions): Promise<void> {
  const store = await cookies()
  const sealed = seal(JSON.stringify(value))
  const count = Math.ceil(sealed.length / CHUNK_SIZE)
  if (count > MAX_CHUNKS) throw new Error(`Cookie "${name}" is too large (${sealed.length} bytes).`)
  for (let i = 0; i < count; i++) {
    store.set(chunkName(name, i), sealed.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), {
      httpOnly: true,
      sameSite: 'lax',
      secure: entraConfig().secureCookies,
      path: options.path ?? '/',
      maxAge: options.maxAgeSeconds,
    })
  }
  removeChunks(store, name, count, options.path)
}

/** The cookie's value when present, intact and matching `schema`; otherwise undefined. */
export async function readSealedCookie<T, Input>(name: string, schema: ZodType<T, ZodTypeDef, Input>): Promise<T | undefined> {
  const store = await cookies()
  let sealed = ''
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const part = store.get(chunkName(name, i))?.value
    if (!part) break
    sealed += part
  }
  if (!sealed) return undefined
  const plain = unseal(sealed)
  if (plain === undefined) return undefined
  try {
    const parsed = schema.safeParse(JSON.parse(plain))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export async function deleteSealedCookie(name: string, path?: string): Promise<void> {
  removeChunks(await cookies(), name, 0, path)
}

function removeChunks(store: CookieStore, name: string, from: number, path = '/'): void {
  for (let i = from; i < MAX_CHUNKS; i++) {
    if (store.has(chunkName(name, i))) store.delete({ name: chunkName(name, i), path })
  }
}
