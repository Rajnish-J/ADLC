// Unit tests for personal access tokens: format, hashing and the revoked / expired checks. Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ACCESS_TOKEN_PREFIX, CreateAccessTokenInputSchema, isAccessToken } from '@sdlc/contracts'
import { bearerToken } from '../entra'
import { generateAccessToken, hashAccessToken, tokenUsable } from './accessTokens'

describe('personal access tokens', () => {
  it('are prefixed, random and URL-safe', () => {
    const a = generateAccessToken()
    const b = generateAccessToken()
    assert.ok(a.startsWith(ACCESS_TOKEN_PREFIX))
    assert.match(a, /^sdlc_pat_[A-Za-z0-9_-]{43}$/)
    assert.notEqual(a, b)
    assert.ok(isAccessToken(a))
    assert.equal(bearerToken(`Bearer ${a}`), a)
  })

  it('are told apart from Microsoft access tokens', () => {
    assert.equal(isAccessToken('eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.e30.sig'), false)
    assert.equal(isAccessToken(undefined), false)
  })

  it('are stored as a stable SHA-256, never as themselves', () => {
    const token = generateAccessToken()
    const hash = hashAccessToken(token)
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.equal(hash, hashAccessToken(token))
    assert.notEqual(hash, hashAccessToken(generateAccessToken()))
    assert.ok(!hash.includes(token))
  })

  it('stop working once revoked or expired', () => {
    const now = new Date('2026-11-19T12:00:00Z')
    assert.equal(tokenUsable({ revokedAt: null, expiresAt: null }, now), true)
    assert.equal(tokenUsable({ revokedAt: null, expiresAt: new Date('2026-12-01T00:00:00Z') }, now), true)
    assert.equal(tokenUsable({ revokedAt: null, expiresAt: new Date('2026-11-19T11:59:59Z') }, now), false)
    assert.equal(tokenUsable({ revokedAt: new Date('2026-11-18T00:00:00Z'), expiresAt: null }, now), false)
  })

  it('expire after 90 days unless told otherwise', () => {
    assert.equal(CreateAccessTokenInputSchema.parse({ name: 'Laptop' }).expiresInDays, 90)
    assert.equal(CreateAccessTokenInputSchema.parse({ name: 'Laptop', expiresInDays: null }).expiresInDays, null)
    assert.throws(() => CreateAccessTokenInputSchema.parse({ name: ' ' }))
    assert.throws(() => CreateAccessTokenInputSchema.parse({ name: 'x', expiresInDays: 7 }))
  })
})
