// Repository access tokens at rest: AES-256-GCM with a key from REPO_CREDENTIAL_KEY. The token is decrypted only
// to hand it to git (through environment variables) and is never returned by the API or written to logs.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

const VERSION = 'v1'
/** Development-only fallback (loadConfig refuses to start production without REPO_CREDENTIAL_KEY). */
const DEV_KEY_MATERIAL = 'sdlc-platform-development-repository-credential-key'

export class CredentialCipher {
  private readonly key: Buffer

  constructor(keyMaterial: string | undefined) {
    this.key = CredentialCipher.deriveKey(keyMaterial)
  }

  /** 32 bytes of base64 are used as-is; any other string is hashed to 32 bytes. */
  static deriveKey(material: string | undefined): Buffer {
    const raw = material?.trim() || DEV_KEY_MATERIAL
    const decoded = /^[A-Za-z0-9+/]{43}=$/.test(raw) ? Buffer.from(raw, 'base64') : null
    return decoded && decoded.length === 32 ? decoded : createHash('sha256').update(raw, 'utf8').digest()
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
  }

  decrypt(stored: string): string {
    const [version, iv, tag, ct] = stored.split(':')
    if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('Unrecognised credential format.')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8')
  }
}

/** The last 4 characters, so an owner can tell which token is stored without seeing it. */
export function tokenHint(token: string): string {
  return token.length <= 8 ? '…' : `…${token.slice(-4)}`
}
