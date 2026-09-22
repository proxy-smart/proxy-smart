// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Client Assertion & Federated Authentication Tests
 *
 * Tests for private_key_jwt validation and proxy assertion translation
 * for Keycloak's federated client authentication.
 *
 * Mocks:
 * - cross-fetch: intercepts Keycloak admin API calls
 * - config: provides deterministic test values
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { generateKeyPairSync, createPublicKey, randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'

// ─── RSA Key Pair for test signing ──────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

// Convert public key PEM to JWK for the mock JWKS response
const publicKeyObject = createPublicKey(publicKey)
const publicJwk = publicKeyObject.export({ format: 'jwk' })
const TEST_KID = 'test-key-1'
const TEST_CLIENT_ID = 'backend-service-client'
const TEST_BASE_URL = 'http://localhost:8445'
const TEST_KC_BASE_URL = 'http://localhost:8080'
const TEST_REALM = 'smart-health'
const TEST_INTERNAL_CLIENT_UUID = 'uuid-1234'

// JWKS that Keycloak would return for the client
const clientJwks = {
  keys: [{
    ...publicJwk,
    kid: TEST_KID,
    use: 'sig',
    alg: 'RS384',
  }]
}

// ─── Mock fetch to intercept all Keycloak admin API calls ───────────────────

let fetchMock: ReturnType<typeof mock>

function createFetchMock() {
  return mock((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url

    // Admin token endpoint (for getAdminToken → getClientMetadata)
    if (urlStr.includes('/protocol/openid-connect/token') && init?.body?.toString().includes('client_credentials')) {
      return Promise.resolve(new Response(JSON.stringify({
        access_token: 'admin-token-123',
        token_type: 'Bearer',
        expires_in: 300,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }

    // Client lookup by clientId (admin API)
    if (urlStr.includes('/admin/realms/') && urlStr.includes('clients?clientId=')) {
      return Promise.resolve(new Response(JSON.stringify([{
        id: TEST_INTERNAL_CLIENT_UUID,
        clientId: TEST_CLIENT_ID,
        attributes: {
          'jwks.string': JSON.stringify(clientJwks),
        },
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }

    // Fallback — unknown URL
    return Promise.resolve(new Response('Not Found', { status: 404 }))
  })
}

// ─── Module mocking ─────────────────────────────────────────────────────────

// We need to mock cross-fetch and config before importing the module under test
mock.module('cross-fetch', () => ({
  default: (...args: unknown[]) => fetchMock(...args),
}))

// NOTE: Do NOT mock.module('@/config') — it's global in Bun and leaks to other
// test files. Instead, set env vars so the real config's dynamic getters pick
// them up. Save and restore in beforeEach/afterEach.
const CONFIG_ENV_VARS = {
  BASE_URL: TEST_BASE_URL,
  KEYCLOAK_BASE_URL: TEST_KC_BASE_URL,
  KEYCLOAK_REALM: TEST_REALM,
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret',
} as const

mockLoggerModule()

// ─── Import after mocking ───────────────────────────────────────────────────

const { hasClientAssertion, translateClientAssertion, validateClientAssertion, ClientAssertionError, clearJtiCache } = await import(
  '../src/routes/auth/backend-services'
)

// ─── Helper: create a valid JWT assertion ───────────────────────────────────

function createClientAssertion(overrides?: {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
  jti?: string
  kid?: string
  algorithm?: jwt.Algorithm
}): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: overrides?.iss ?? TEST_CLIENT_ID,
    sub: overrides?.sub ?? TEST_CLIENT_ID,
    aud: overrides?.aud ?? `${TEST_BASE_URL}/auth/token`,
    exp: overrides?.exp ?? now + 300,
    jti: overrides?.jti ?? randomUUID(),
    iat: now,
  }

  return jwt.sign(payload, privateKey, {
    algorithm: overrides?.algorithm ?? 'RS384',
    header: {
      alg: overrides?.algorithm ?? 'RS384',
      kid: overrides?.kid ?? TEST_KID,
      typ: 'JWT',
    },
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Backend Services', () => {
  let envSnapshot: Record<string, string | undefined>

  beforeEach(() => {
    // Snapshot env vars that we'll override
    envSnapshot = {}
    for (const key of Object.keys(CONFIG_ENV_VARS)) {
      envSnapshot[key] = process.env[key]
    }
    // Set config env vars for this test
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      process.env[key] = value
    }
    fetchMock = createFetchMock()
    clearJtiCache()
  })

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  describe('hasClientAssertion', () => {
    it('detects assertion in client_credentials request', () => {
      expect(hasClientAssertion({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'some.jwt.here',
      })).toBe(true)
    })

    it('detects assertion in authorization_code request', () => {
      expect(hasClientAssertion({
        grant_type: 'authorization_code',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'some.jwt.here',
      })).toBe(true)
    })

    it('detects assertion regardless of grant_type', () => {
      expect(hasClientAssertion({
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'some.jwt.here',
      })).toBe(true)
    })

    it('rejects when client_assertion_type is wrong', () => {
      expect(hasClientAssertion({
        grant_type: 'client_credentials',
        client_assertion_type: 'wrong',
        client_assertion: 'some.jwt.here',
      })).toBe(false)
    })

    it('rejects when client_assertion is missing', () => {
      expect(hasClientAssertion({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      })).toBe(false)
    })
  })

  describe('translateClientAssertion', () => {
    it('validates assertion and returns proxy-signed assertion (happy path)', async () => {
      const assertion = createClientAssertion()
      const result = await translateClientAssertion(assertion, TEST_CLIENT_ID)

      expect(result.clientId).toBe(TEST_CLIENT_ID)
      expect(result.proxyAssertion).toBeDefined()
      expect(typeof result.proxyAssertion).toBe('string')

      // Verify proxy assertion structure
      const decoded = jwt.decode(result.proxyAssertion) as jwt.JwtPayload
      expect(decoded.iss).toBe(TEST_BASE_URL)
      expect(decoded.sub).toBe(TEST_CLIENT_ID)
      expect(decoded.aud).toBe(`${TEST_KC_BASE_URL}/realms/${TEST_REALM}`)
      expect(decoded.jti).toBeDefined()
      expect(decoded.exp).toBeDefined()
    })

    it('proxy assertion uses RS256 and includes kid', async () => {
      const assertion = createClientAssertion()
      const { proxyAssertion } = await translateClientAssertion(assertion, TEST_CLIENT_ID)

      const header = jwt.decode(proxyAssertion, { complete: true })?.header
      expect(header?.alg).toBe('RS256')
      expect(header?.kid).toBeDefined()
    })

    it('rejects invalid JWT (not a JWT)', async () => {
      await expect(translateClientAssertion('not-a-jwt')).rejects.toBeInstanceOf(ClientAssertionError)
    })

    it('rejects JWT where iss !== sub', async () => {
      const assertion = createClientAssertion({ iss: 'client-a', sub: 'client-b' })
      await expect(translateClientAssertion(assertion)).rejects.toBeInstanceOf(ClientAssertionError)
    })

    it('rejects JWT with wrong audience', async () => {
      const assertion = createClientAssertion({ aud: 'https://wrong.example.com/token' })
      const err = await translateClientAssertion(assertion).catch(e => e)
      expect(err).toBeInstanceOf(ClientAssertionError)
      expect(err.description).toContain('audience')
    })

    it('rejects expired JWT', async () => {
      const assertion = createClientAssertion({ exp: Math.floor(Date.now() / 1000) - 120 })
      await expect(translateClientAssertion(assertion)).rejects.toBeInstanceOf(ClientAssertionError)
    })

    it('rejects JWT without jti', async () => {
      const now = Math.floor(Date.now() / 1000)
      const token = jwt.sign(
        { iss: TEST_CLIENT_ID, sub: TEST_CLIENT_ID, aud: `${TEST_BASE_URL}/auth/token`, exp: now + 300 },
        privateKey,
        { algorithm: 'RS384', header: { alg: 'RS384', kid: TEST_KID, typ: 'JWT' } }
      )
      await expect(translateClientAssertion(token)).rejects.toBeInstanceOf(ClientAssertionError)
    })

    it('rejects replayed jti', async () => {
      const fixedJti = 'translate-replay-jti'
      await translateClientAssertion(createClientAssertion({ jti: fixedJti }))
      await expect(
        translateClientAssertion(createClientAssertion({ jti: fixedJti }))
      ).rejects.toBeInstanceOf(ClientAssertionError)
    })

    it('rejects when client_id body param does not match JWT iss', async () => {
      const assertion = createClientAssertion()
      const err = await translateClientAssertion(assertion, 'wrong-client-id').catch(e => e)
      expect(err).toBeInstanceOf(ClientAssertionError)
      expect(err.description).toContain('client_id')
    })

    it('rejects JWT signed with wrong key', async () => {
      const { privateKey: wrongKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      })

      const now = Math.floor(Date.now() / 1000)
      const assertion = jwt.sign(
        {
          iss: TEST_CLIENT_ID,
          sub: TEST_CLIENT_ID,
          aud: `${TEST_BASE_URL}/auth/token`,
          exp: now + 300,
          jti: randomUUID(),
        },
        wrongKey,
        { algorithm: 'RS384', header: { alg: 'RS384', kid: TEST_KID, typ: 'JWT' } }
      )

      await expect(translateClientAssertion(assertion)).rejects.toBeInstanceOf(ClientAssertionError)
    })

    it('handles client with no JWKS registered', async () => {
      const originalFetch = fetchMock
      fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url

        if (urlStr.includes('/admin/realms/') && urlStr.includes('clients?clientId=')) {
          return Promise.resolve(new Response(JSON.stringify([{
            id: TEST_INTERNAL_CLIENT_UUID,
            clientId: TEST_CLIENT_ID,
            attributes: {},
          }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        }

        return originalFetch(url, init)
      })

      const assertion = createClientAssertion()
      const err = await translateClientAssertion(assertion).catch(e => e)
      expect(err).toBeInstanceOf(ClientAssertionError)
      expect(err.description).toContain('JWKS')
    })

    it('rejects JWT with exp more than 5 minutes in the future', async () => {
      const assertion = createClientAssertion({ exp: Math.floor(Date.now() / 1000) + 600 })
      const err = await translateClientAssertion(assertion).catch(e => e)
      expect(err).toBeInstanceOf(ClientAssertionError)
      expect(err.description).toContain('5 minutes')
    })
  })

  describe('validateClientAssertion', () => {
    it('returns clientId and internalId for a valid assertion', async () => {
      const result = await validateClientAssertion(createClientAssertion(), TEST_CLIENT_ID)
      expect(result.clientId).toBe(TEST_CLIENT_ID)
      expect(result.internalId).toBe(TEST_INTERNAL_CLIENT_UUID)
    })

    it('throws ClientAssertionError for an invalid JWT string', async () => {
      await expect(validateClientAssertion('not.a.jwt', undefined)).rejects.toBeInstanceOf(ClientAssertionError)
    })

    it('throws ClientAssertionError for wrong aud', async () => {
      const assertion = createClientAssertion({ aud: 'https://wrong.example.com/token' })
      const err = await validateClientAssertion(assertion, undefined).catch(e => e)
      expect(err).toBeInstanceOf(ClientAssertionError)
      expect(err.oauthError).toBe('invalid_client')
      expect(err.description).toContain('audience')
    })

    it('throws ClientAssertionError for mismatched iss/sub', async () => {
      const assertion = createClientAssertion({ iss: 'client-a', sub: 'client-b' })
      await expect(validateClientAssertion(assertion, undefined)).rejects.toBeInstanceOf(ClientAssertionError)
    })

    it('throws ClientAssertionError when client_id body param does not match iss', async () => {
      const assertion = createClientAssertion()
      const err = await validateClientAssertion(assertion, 'wrong-client').catch(e => e)
      expect(err).toBeInstanceOf(ClientAssertionError)
      expect(err.description).toContain('client_id')
    })

    it('does NOT throw when optional client_id matches iss', async () => {
      const result = await validateClientAssertion(createClientAssertion(), TEST_CLIENT_ID)
      expect(result.clientId).toBe(TEST_CLIENT_ID)
    })

    it('prevents jti replay', async () => {
      const fixedJti = 'validate-replay-jti'
      await validateClientAssertion(createClientAssertion({ jti: fixedJti }))
      const err = await validateClientAssertion(createClientAssertion({ jti: fixedJti })).catch(e => e)
      expect(err).toBeInstanceOf(ClientAssertionError)
      expect(err.description).toContain('jti')
    })
  })

  // ── VULN 2 (HIGH): SSRF via unvalidated DCR jwks_uri fetched server-side ──
  // A client whose stored jwks.url points to an internal/metadata host must
  // NEVER be fetched server-side. The assertion flow must reject as
  // invalid_client BEFORE issuing the request.
  describe('jwks_uri SSRF protection (defense in depth)', () => {
    /** Build a fetch mock whose client lookup returns an internal jwks.url. */
    function fetchMockWithJwksUrl(jwksUrl: string): ReturnType<typeof mock> {
      return mock((url: string | URL | Request, _init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url

        // Admin token endpoint
        if (urlStr.includes('/protocol/openid-connect/token') && _init?.body?.toString().includes('client_credentials')) {
          return Promise.resolve(new Response(JSON.stringify({
            access_token: 'admin-token-123', token_type: 'Bearer', expires_in: 300,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        }

        // Client lookup → client configured with a jwks.url (not inline string)
        if (urlStr.includes('/admin/realms/') && urlStr.includes('clients?clientId=')) {
          return Promise.resolve(new Response(JSON.stringify([{
            id: TEST_INTERNAL_CLIENT_UUID,
            clientId: TEST_CLIENT_ID,
            attributes: { 'use.jwks.url': 'true', 'jwks.url': jwksUrl },
          }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        }

        // If the JWKS URL is ever fetched, return a valid JWKS so the test
        // would PASS the assertion — proving the SSRF guard is the only thing
        // standing between the attacker and the internal request.
        if (urlStr === jwksUrl) {
          return Promise.resolve(new Response(JSON.stringify(clientJwks), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }

        return Promise.resolve(new Response('Not Found', { status: 404 }))
      })
    }

    it('does NOT fetch a jwks.url that resolves to the cloud metadata endpoint', async () => {
      const internalJwks = 'http://169.254.169.254/latest/meta-data/'
      fetchMock = fetchMockWithJwksUrl(internalJwks)

      const err = await validateClientAssertion(createClientAssertion(), TEST_CLIENT_ID).catch(e => e)

      // Must reject the flow.
      expect(err).toBeInstanceOf(ClientAssertionError)
      // And must NEVER have issued a request to the internal URL.
      const fetchedInternal = fetchMock.mock.calls.some(([u]) => {
        const s = typeof u === 'string' ? u : u instanceof URL ? u.toString() : (u as Request).url
        return s === internalJwks
      })
      expect(fetchedInternal).toBe(false)
    })

    it('does NOT fetch a jwks.url on an RFC1918 private host', async () => {
      const internalJwks = 'http://10.0.0.5/jwks'
      fetchMock = fetchMockWithJwksUrl(internalJwks)

      const err = await validateClientAssertion(createClientAssertion(), TEST_CLIENT_ID).catch(e => e)

      expect(err).toBeInstanceOf(ClientAssertionError)
      const fetchedInternal = fetchMock.mock.calls.some(([u]) => {
        const s = typeof u === 'string' ? u : u instanceof URL ? u.toString() : (u as Request).url
        return s === internalJwks
      })
      expect(fetchedInternal).toBe(false)
    })

    it('does NOT fetch a non-http(s) jwks.url (e.g. file://)', async () => {
      const internalJwks = 'file:///etc/passwd'
      fetchMock = fetchMockWithJwksUrl(internalJwks)

      const err = await validateClientAssertion(createClientAssertion(), TEST_CLIENT_ID).catch(e => e)

      expect(err).toBeInstanceOf(ClientAssertionError)
      const fetchedInternal = fetchMock.mock.calls.some(([u]) => {
        const s = typeof u === 'string' ? u : u instanceof URL ? u.toString() : (u as Request).url
        return s === internalJwks
      })
      expect(fetchedInternal).toBe(false)
    })

    it('STILL fetches a legitimate public https jwks.url (no regression)', async () => {
      const publicJwksUrl = 'https://client.example.com/.well-known/jwks.json'
      fetchMock = fetchMockWithJwksUrl(publicJwksUrl)

      const result = await validateClientAssertion(createClientAssertion(), TEST_CLIENT_ID)
      expect(result.clientId).toBe(TEST_CLIENT_ID)

      const fetchedPublic = fetchMock.mock.calls.some(([u]) => {
        const s = typeof u === 'string' ? u : u instanceof URL ? u.toString() : (u as Request).url
        return s === publicJwksUrl
      })
      expect(fetchedPublic).toBe(true)
    })
  })
})
