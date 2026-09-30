// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { signTestToken, TEST_KEY_ID } from './helpers/jwt-test-keys'
import { validateToken } from '../src/lib/auth'

const ENV: Record<string, string> = {
  KEYCLOAK_BASE_URL: 'http://localhost:8080',
  KEYCLOAK_PUBLIC_URL: 'http://localhost:8080',
  KEYCLOAK_REALM: 'proxy-smart',
}
const ISSUER = 'http://localhost:8080/realms/proxy-smart'
const snapshot: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) {
    snapshot[key] = process.env[key]
    process.env[key] = value
  }
})

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (snapshot[key] === undefined) delete process.env[key]
    else process.env[key] = snapshot[key]
  }
})

const reason = (token: string) =>
  validateToken(token, { enforceAudience: false }).then(
    () => 'accepted',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

describe('validateToken error mapping', () => {
  it('accepts a valid token', async () => {
    expect(await reason(signTestToken({ iss: ISSUER }))).toBe('accepted')
  })

  it('reports an expired token as expired', async () => {
    expect(await reason(signTestToken({ iss: ISSUER, expiresIn: -60 }))).toBe('Token has expired')
  })

  it('reports a token used before nbf as not yet valid', async () => {
    const nbf = Math.floor(Date.now() / 1000) + 3600
    expect(await reason(signTestToken({ iss: ISSUER, extra: { nbf } }))).toBe('Token not yet valid')
  })

  it('rejects a signature from any other key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const forged = jwt.sign({ sub: 'x', iss: ISSUER }, privateKey, { algorithm: 'RS256', keyid: TEST_KEY_ID, expiresIn: '5m' })
    expect(await reason(forged)).toStartWith('Invalid token:')
  })

  it('rejects an algorithm outside the allow list', async () => {
    const hs = jwt.sign({ sub: 'x', iss: ISSUER }, 'shared-secret', { algorithm: 'HS256', expiresIn: '5m' })
    expect(await reason(hs)).toStartWith('Invalid token:')
  })

  it('rejects a token from another issuer', async () => {
    expect(await reason(signTestToken({ iss: 'https://evil.example/realms/proxy-smart' }))).toStartWith('Invalid token:')
  })

  it('rejects something that is not a JWT at all', async () => {
    expect(await reason('not-a-jwt')).toBe('Invalid token format')
  })
})
