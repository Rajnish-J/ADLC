// Unit tests for Entra access-token verification, with tokens signed by a local key. Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { generateKeyPair, SignJWT, type CryptoKey } from 'jose'
import { bearerToken, createEntraVerifier, type EntraTokenVerifier } from './entra'
import { HttpError } from './http'

const TENANT = '11111111-1111-4111-8111-111111111111'
const CLIENT = '22222222-2222-4222-8222-222222222222'
const OID = '33333333-3333-4333-8333-333333333333'

const V2_CLAIMS: Record<string, string> = {
  iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  aud: CLIENT,
  tid: TENANT,
  oid: OID,
  scp: 'access_as_user',
  name: 'Asha Rao',
  preferred_username: 'asha.rao@contoso.com',
}

let privateKey: CryptoKey
let verify: EntraTokenVerifier

async function token(claims: Record<string, string>, expiresIn = '1h', key: CryptoKey = privateKey): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime(expiresIn).sign(key)
}

async function rejects(promise: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(promise, (err: Error) => err instanceof HttpError && err.statusCode === 401 && message.test(err.message))
}

before(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  verify = createEntraVerifier({ tenantId: TENANT, clientId: CLIENT, keys: async () => pair.publicKey })
})

describe('createEntraVerifier', () => {
  it('accepts a v2 delegated token and returns the identity', async () => {
    assert.deepEqual(await verify(await token(V2_CLAIMS)), {
      oid: OID,
      tenantId: TENANT,
      email: 'asha.rao@contoso.com',
      displayName: 'Asha Rao',
    })
  })

  it('accepts a v1 token (sts.windows.net issuer, api:// audience, upn)', async () => {
    const { preferred_username: _, ...rest } = V2_CLAIMS
    const id = await verify(
      await token({ ...rest, iss: `https://sts.windows.net/${TENANT}/`, aud: `api://${CLIENT}`, upn: 'asha.rao@contoso.com' }),
    )
    assert.equal(id.email, 'asha.rao@contoso.com')
  })

  it('refuses another audience, issuer or tenant', async () => {
    await rejects(verify(await token({ ...V2_CLAIMS, aud: 'api://someone-else' })), /not valid/)
    await rejects(verify(await token({ ...V2_CLAIMS, iss: 'https://login.microsoftonline.com/common/v2.0' })), /not valid/)
    await rejects(verify(await token({ ...V2_CLAIMS, tid: '44444444-4444-4444-8444-444444444444' })), /another tenant/)
  })

  it('refuses app-only tokens (no scp)', async () => {
    const { scp: _, ...appOnly } = V2_CLAIMS
    await rejects(verify(await token({ ...appOnly, roles: 'Tasks.ReadWrite' })), /delegated user token/)
  })

  it('refuses expired tokens and tokens signed by another key', async () => {
    await rejects(verify(await token(V2_CLAIMS, '-10m')), /expired/)
    const other = await generateKeyPair('RS256')
    await rejects(verify(await token(V2_CLAIMS, '1h', other.privateKey)), /not valid/)
  })
})

describe('bearerToken', () => {
  it('reads the token from an Authorization header', () => {
    assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi')
    assert.equal(bearerToken('bearer abc'), 'abc')
    assert.equal(bearerToken('Basic abc'), undefined)
    assert.equal(bearerToken(undefined), undefined)
  })
})
