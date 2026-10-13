// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { signTestToken } from './helpers/jwt-test-keys'

const KC_BASE = 'http://localhost:8080'
const REALM = 'proxy-smart'
const ISSUER = `${KC_BASE}/realms/${REALM}`
const FHIR_AUD = 'http://localhost:8445/proxy-smart-backend/hapi/R4'

const ENV: Record<string, string> = {
  KEYCLOAK_BASE_URL: KC_BASE,
  KEYCLOAK_PUBLIC_URL: KC_BASE,
  KEYCLOAK_REALM: REALM,
  BASE_URL: 'http://localhost:8445',
}
const ENV_SNAPSHOT: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    ENV_SNAPSHOT[k] = process.env[k]
    process.env[k] = v
  }
})

afterAll(() => {
  for (const k of Object.keys(ENV)) {
    const previous = ENV_SNAPSHOT[k]
    if (previous === undefined) delete process.env[k]
    else process.env[k] = previous
  }
})

const { validateToken } = await import('../src/lib/auth')
const { markTokenRevoked, isTokenRevoked } = await import('../src/lib/revoked-tokens')

const mint = (jti: string) => signTestToken({ iss: ISSUER, aud: FHIR_AUD, extra: { jti } })

describe('a revoked access token is refused by this proxy', () => {
  it('accepts the token before it is revoked and refuses it after', async () => {
    const token = mint('revoked-1')
    await validateToken(token, { audience: FHIR_AUD })

    markTokenRevoked('revoked-1', Math.floor(Date.now() / 1000) + 300)

    await expect(validateToken(token, { audience: FHIR_AUD })).rejects.toThrow('revoked')
  })

  it('leaves other tokens alone', async () => {
    markTokenRevoked('revoked-2', Math.floor(Date.now() / 1000) + 300)

    await validateToken(mint('still-good'), { audience: FHIR_AUD })
  })

  it('does not remember a token that has already expired', () => {
    markTokenRevoked('long-gone', Math.floor(Date.now() / 1000) - 10)

    expect(isTokenRevoked('long-gone')).toBe(false)
  })
})
