// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { fakeFetch } from './helpers/fake-fetch'
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { generateKeyPairSync, randomUUID, type KeyObject } from 'crypto'
import jwt from 'jsonwebtoken'

const BASE_URL = 'http://localhost:8445'
const CLIENT_ID = 'backend-service-client'
const JWKS_URL = 'https://client.example.com/.well-known/jwks.json'

const ENV = {
  BASE_URL,
  KEYCLOAK_BASE_URL: 'http://localhost:8080',
  KEYCLOAK_REALM: 'smart-health',
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret',
  JWKS_REFETCH_MIN_INTERVAL_MS: '60000',
} as const

interface TestKey { privateKey: KeyObject; jwk: Record<string, unknown> }

function rsaKey(kid: string, extra: Record<string, unknown> = { alg: 'RS384' }): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', ...extra } }
}

function ecKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' })
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES384' } }
}

const rsa = rsaKey('rsa-1')

interface JwksResponse { keys: Record<string, unknown>[]; headers?: Record<string, string>; status?: number; body?: unknown }

let registration: Record<string, string> = {}
let jwksResponse: JwksResponse = { keys: [rsa.jwk] }
let jwksRequests: RequestInit[] = []

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.toString() : input.url
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

const fetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url = urlOf(input)
  if (url.includes('/protocol/openid-connect/token')) {
    return Promise.resolve(json({ access_token: 'admin-token', expires_in: 300 }))
  }
  if (url.includes('clients?clientId=')) {
    return Promise.resolve(json([{ id: 'uuid-1', clientId: CLIENT_ID, attributes: registration }]))
  }
  if (url === JWKS_URL) {
    jwksRequests.push(init ?? {})
    return Promise.resolve(json(jwksResponse.body ?? { keys: jwksResponse.keys }, jwksResponse.headers, jwksResponse.status))
  }
  return Promise.resolve(new Response('Not Found', { status: 404 }))
})

globalThis.fetch = fakeFetch(fetchMock)
mockLoggerModule()

const { validateClientAssertion, ClientAssertionError, clearJtiCache } = await import('../src/routes/auth/backend-services')

function assertion(key: KeyObject, header: { alg: jwt.Algorithm; kid?: string }): string {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    { iss: CLIENT_ID, sub: CLIENT_ID, aud: `${BASE_URL}/auth/token`, exp: now + 240, jti: randomUUID() },
    key,
    { algorithm: header.alg, header: { alg: header.alg, typ: 'JWT', ...(header.kid !== undefined && { kid: header.kid }) } },
  )
}

const inline = (keys: Record<string, unknown>[]) => ({ 'use.jwks.string': 'true', 'jwks.string': JSON.stringify({ keys }) })
const byUrl = { 'use.jwks.url': 'true', 'jwks.url': JWKS_URL }

async function rejection(token: string): Promise<unknown> {
  return validateClientAssertion(token, CLIENT_ID).then(() => null, (error: unknown) => error)
}

describe('client assertion key selection and JWKS caching', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
    registration = inline([rsa.jwk])
    jwksResponse = { keys: [rsa.jwk] }
    jwksRequests = []
    clearJtiCache()
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  describe('key selection (asymmetric step 3)', () => {
    it('accepts an RS384 assertion whose kid matches exactly one key', async () => {
      await expect(validateClientAssertion(assertion(rsa.privateKey, { alg: 'RS384', kid: 'rsa-1' }), CLIENT_ID))
        .resolves.toMatchObject({ clientId: CLIENT_ID })
    })

    it('accepts an ES384 assertion against an EC key', async () => {
      const ec = ecKey('ec-1')
      registration = inline([rsa.jwk, ec.jwk])
      await expect(validateClientAssertion(assertion(ec.privateKey, { alg: 'ES384', kid: 'ec-1' }), CLIENT_ID))
        .resolves.toMatchObject({ clientId: CLIENT_ID })
    })

    it('rejects an assertion without a kid instead of falling back to the first key', async () => {
      expect(await rejection(assertion(rsa.privateKey, { alg: 'RS384' }))).toBeInstanceOf(ClientAssertionError)
    })

    it('rejects when more than one key carries the kid', async () => {
      const twin = rsaKey('rsa-1')
      registration = inline([rsa.jwk, twin.jwk])
      expect(await rejection(assertion(rsa.privateKey, { alg: 'RS384', kid: 'rsa-1' }))).toBeInstanceOf(ClientAssertionError)
    })

    it('rejects when the only key with the kid has the wrong kty for the algorithm', async () => {
      const ec = ecKey('rsa-1')
      registration = inline([ec.jwk])
      expect(await rejection(assertion(rsa.privateKey, { alg: 'RS384', kid: 'rsa-1' }))).toBeInstanceOf(ClientAssertionError)
    })

    it('rejects when the key declares a different alg than the header', async () => {
      const strict = rsaKey('rsa-512', { alg: 'RS512' })
      registration = inline([strict.jwk])
      expect(await rejection(assertion(strict.privateKey, { alg: 'RS384', kid: 'rsa-512' }))).toBeInstanceOf(ClientAssertionError)
    })

    it('rejects an algorithm outside RS384/ES384 even when the key would verify it', async () => {
      const loose = rsaKey('loose', {})
      registration = inline([loose.jwk])
      expect(await rejection(assertion(loose.privateKey, { alg: 'RS256', kid: 'loose' }))).toBeInstanceOf(ClientAssertionError)
    })

    it('ignores a key reserved for encryption', async () => {
      const enc = rsaKey('rsa-1', { alg: 'RS384', use: 'enc' })
      registration = inline([enc.jwk])
      expect(await rejection(assertion(enc.privateKey, { alg: 'RS384', kid: 'rsa-1' }))).toBeInstanceOf(ClientAssertionError)
    })
  })

  describe('JWKS fetch', () => {
    beforeEach(() => {
      registration = byUrl
    })

    it('asks for JSON, bounds the request in time and does not follow redirects', async () => {
      await validateClientAssertion(assertion(rsa.privateKey, { alg: 'RS384', kid: 'rsa-1' }), CLIENT_ID)

      expect(jwksRequests).toHaveLength(1)
      expect(new Headers(jwksRequests[0].headers).get('accept')).toBe('application/json')
      expect(jwksRequests[0].redirect).toBe('manual')
      expect(jwksRequests[0].signal).toBeInstanceOf(AbortSignal)
    })

    it('refuses a JWKS URL that answers with a redirect', async () => {
      jwksResponse = { keys: [], status: 302, headers: { Location: 'http://169.254.169.254/latest' } }
      expect(await rejection(assertion(rsa.privateKey, { alg: 'RS384', kid: 'rsa-1' }))).toBeInstanceOf(ClientAssertionError)
    })

    it('refuses a JWKS document without a keys array', async () => {
      jwksResponse = { keys: [], body: { not: 'a jwks' } }
      expect(await rejection(assertion(rsa.privateKey, { alg: 'RS384', kid: 'rsa-1' }))).toBeInstanceOf(ClientAssertionError)
    })
  })

  describe('JWKS caching follows the client Cache-Control header', () => {
    beforeEach(() => {
      registration = byUrl
    })

    const validate = () => validateClientAssertion(assertion(rsa.privateKey, { alg: 'RS384', kid: 'rsa-1' }), CLIENT_ID)

    it('reuses a JWKS within its max-age', async () => {
      jwksResponse = { keys: [rsa.jwk], headers: { 'Cache-Control': 'public, max-age=3600' } }
      await validate()
      await validate()
      expect(jwksRequests).toHaveLength(1)
    })

    it('does not cache a JWKS marked no-store', async () => {
      jwksResponse = { keys: [rsa.jwk], headers: { 'Cache-Control': 'no-store' } }
      await validate()
      await validate()
      expect(jwksRequests).toHaveLength(2)
    })

    it('does not cache a JWKS marked no-cache', async () => {
      jwksResponse = { keys: [rsa.jwk], headers: { 'Cache-Control': 'no-cache' } }
      await validate()
      await validate()
      expect(jwksRequests).toHaveLength(2)
    })

    it('does not cache a JWKS with max-age=0', async () => {
      jwksResponse = { keys: [rsa.jwk], headers: { 'Cache-Control': 'max-age=0' } }
      await validate()
      await validate()
      expect(jwksRequests).toHaveLength(2)
    })

    it('refetches once on an unknown kid so a rotated key is picked up', async () => {
      jwksResponse = { keys: [rsa.jwk], headers: { 'Cache-Control': 'max-age=3600' } }
      await validate()

      const rotated = rsaKey('rsa-2')
      jwksResponse = { keys: [rotated.jwk], headers: { 'Cache-Control': 'max-age=3600' } }
      await expect(validateClientAssertion(assertion(rotated.privateKey, { alg: 'RS384', kid: 'rsa-2' }), CLIENT_ID))
        .resolves.toMatchObject({ clientId: CLIENT_ID })
      expect(jwksRequests).toHaveLength(2)
    })

    it('rate-limits the unknown-kid refetch', async () => {
      jwksResponse = { keys: [rsa.jwk], headers: { 'Cache-Control': 'max-age=3600' } }
      await validate()

      const stranger = rsaKey('unknown')
      await rejection(assertion(stranger.privateKey, { alg: 'RS384', kid: 'unknown' }))
      await rejection(assertion(stranger.privateKey, { alg: 'RS384', kid: 'unknown' }))
      expect(jwksRequests).toHaveLength(2)
    })
  })
})
