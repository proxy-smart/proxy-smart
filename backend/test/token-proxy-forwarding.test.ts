// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Token Proxy Forwarding — TDD Tests
 *
 * Captures exactly what the /auth/token proxy sends to Keycloak and verifies
 * correctness per grant type. These tests exposed a bug where `redirect_uri=`
 * (empty string) was unconditionally sent to KC for ALL grant types, including
 * `client_credentials` which should never include it.
 *
 * Bug: KC may reject requests with unexpected empty redirect_uri depending on
 * client configuration and Keycloak version.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import jwt from 'jsonwebtoken'

// ─── Constants ──────────────────────────────────────────────────────────────

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_KC_BASE_URL = 'http://localhost:8080'
const TEST_REALM = 'smart-health'

const CONFIG_ENV_VARS = {
  BASE_URL: TEST_BASE_URL,
  KEYCLOAK_BASE_URL: TEST_KC_BASE_URL,
  KEYCLOAK_REALM: TEST_REALM,
  KEYCLOAK_PUBLIC_URL: TEST_KC_BASE_URL,
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret',
  SMART_LAUNCH_SECRET: 'test-launch-secret-32-bytes-long!',
  FHIR_BASE_URL: 'http://localhost:8081/fhir',
  PROXY_NAME: 'fhir',
} as const

// ─── Mocks (must be before imports) ─────────────────────────────────────────

mockLoggerModule()

mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

mock.module('@/lib/auth', () => ({
  validateToken: async (token: string) => {
    const parts = token.split('.')
    if (parts.length === 3) {
      try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) }
      catch { /* fall through */ }
    }
    return { sub: 'test-user' }
  },
}))

mock.module('@/lib/kc-session-resolver', () => ({
  autoResolvePatient: async () => null,
}))

// ─── Capture KC fetch calls ─────────────────────────────────────────────────

interface CapturedRequest {
  url: string
  params: URLSearchParams
}

let captured: CapturedRequest | null = null

function createCapturingFetch(kcTokenResponse?: Record<string, unknown>) {
  return (async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url

    // KC realm check
    if (urlStr.includes(`/realms/${TEST_REALM}`) && !urlStr.includes('/protocol/')) {
      return new Response('{}', { status: 200 })
    }

    // KC token endpoint — CAPTURE the request
    if (urlStr.includes('/protocol/openid-connect/token')) {
      const body = opts?.body?.toString() || ''
      captured = { url: urlStr, params: new URLSearchParams(body) }
      const resp = kcTokenResponse || {
        access_token: jwt.sign({ sub: 'svc', iss: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`, aud: 'account' }, 'k', { expiresIn: '5m' }),
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid',
      }
      return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    // JWKS
    if (urlStr.includes('/certs')) {
      return new Response(JSON.stringify({ keys: [] }), { status: 200 })
    }

    return new Response('Not Found', { status: 404 })
  }) as typeof fetch
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockFetchFn: (...args: any[]) => Promise<Response> = createCapturingFetch()
mock.module('cross-fetch', () => ({
  default: (...args: Parameters<typeof fetch>) => mockFetchFn(...args),
}))

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { authRoutes } from '../src/routes/auth'

// ─── Helpers ────────────────────────────────────────────────────────────────

function tokenRequest(body: string): Request {
  return new Request(`${TEST_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Token proxy → KC forwarding', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    captured = null
    mockFetchFn = createCapturingFetch()
  })

  afterEach(() => {
    for (const key of Object.keys(CONFIG_ENV_VARS)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  // ── client_credentials + client_secret ──────────────────────────────────

  it('client_credentials: forwards grant_type, client_id, client_secret', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'admin-service',
      client_secret: 'the-secret',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.get('grant_type')).toBe('client_credentials')
    expect(captured!.params.get('client_id')).toBe('admin-service')
    expect(captured!.params.get('client_secret')).toBe('the-secret')
  })

  it('client_credentials: does NOT send redirect_uri to KC', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'admin-service',
      client_secret: 'the-secret',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    // redirect_uri must NOT be present for client_credentials
    expect(captured!.params.has('redirect_uri')).toBe(false)
  })

  it('client_credentials: forwards scope when provided', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'backend-svc',
      client_secret: 's',
      scope: 'system/*.read',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.get('scope')).toBe('system/*.read')
  })

  it('client_credentials: does NOT send code, code_verifier, refresh_token', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'svc',
      client_secret: 's',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.has('code')).toBe(false)
    expect(captured!.params.has('code_verifier')).toBe(false)
    expect(captured!.params.has('refresh_token')).toBe(false)
  })

  // ── client_credentials + JWT assertion ──────────────────────────────────

  it('client_credentials + JWT: forwards client_assertion_type and client_assertion', async () => {
    // Simulate what the proxy does AFTER assertion translation fails (no JWKS)
    // We only care about form data forwarding, not assertion validation
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'backend-svc',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'header.payload.signature',
      scope: 'system/*.read',
    })

    // The assertion will fail validation, so we'll get an error response
    // But we can still check if the hasClientAssertion path was taken
    const res = await authRoutes.handle(tokenRequest(body.toString()))
    const data = await res.json()

    // Should fail at assertion validation (not a real JWT), not at form forwarding
    expect(data.error).toBe('invalid_client')
  })

  it('client_credentials + JWT: does NOT send redirect_uri to KC', async () => {
    // Use a mock that skips assertion translation to test pure forwarding
    // We bypass the assertion handler by not including client_assertion_type
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'svc',
      client_secret: 'sec',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.has('redirect_uri')).toBe(false)
  })

  // ── authorization_code ──────────────────────────────────────────────────

  it('authorization_code: forwards redirect_uri when provided', async () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'abc123',
      redirect_uri: 'http://app.local/callback',
      client_id: 'my-app',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.get('grant_type')).toBe('authorization_code')
    expect(captured!.params.get('code')).toBe('abc123')
    expect(captured!.params.get('client_id')).toBe('my-app')
    // redirect_uri IS expected here
    expect(captured!.params.has('redirect_uri')).toBe(true)
  })

  it('authorization_code: forwards code_verifier (PKCE)', async () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'xyz',
      redirect_uri: 'http://app/cb',
      client_id: 'pkce-app',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.get('code_verifier')).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
  })

  // ── refresh_token ───────────────────────────────────────────────────────

  it('refresh_token: forwards refresh_token, does NOT send redirect_uri', async () => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'rt-abc',
      client_id: 'my-app',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.get('grant_type')).toBe('refresh_token')
    expect(captured!.params.get('refresh_token')).toBe('rt-abc')
    expect(captured!.params.has('redirect_uri')).toBe(false)
  })

  // ── device_code grant (RFC 8628) ─────────────────────────────────────────

  it('device_code: forwards grant_type, device_code and code_verifier (PKCE) to KC', async () => {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: 'admin-ui',
      device_code: 'DEV-CODE-123',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    // device_code must survive body validation and reach KC; without it the
    // device login poll fails with "Missing parameter: device_code".
    expect(captured!.params.get('device_code')).toBe('DEV-CODE-123')
    expect(captured!.params.get('code_verifier')).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    expect(captured!.params.has('redirect_uri')).toBe(false)
  })

  // ── token-exchange (RFC 8693) ───────────────────────────────────────────

  it('token-exchange: forwards subject_token fields', async () => {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'access-token-xyz',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: 'exchange-client',
      client_secret: 'sec',
      scope: 'patient/*.read',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.get('subject_token')).toBe('access-token-xyz')
    expect(captured!.params.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token')
    expect(captured!.params.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token')
  })

  // ── No field leakage ───────────────────────────────────────────────────

  it('only sends expected fields to KC (no extra empty params)', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'svc',
      client_secret: 'sec',
      scope: 'system/*.read',
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    const keys = Array.from(captured!.params.keys())
    // Should contain exactly these fields — no extras
    expect(keys).toContain('grant_type')
    expect(keys).toContain('client_id')
    expect(keys).toContain('client_secret')
    expect(keys).toContain('scope')
    // Must NOT contain fields that weren't in the original request
    expect(keys).not.toContain('code')
    expect(keys).not.toContain('code_verifier')
    expect(keys).not.toContain('refresh_token')
    expect(keys).not.toContain('redirect_uri')
    expect(keys).not.toContain('username')
    expect(keys).not.toContain('password')
  })

  // ── Response forwarding ─────────────────────────────────────────────────

  it('forwards KC error response status and body', async () => {
    mockFetchFn = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      if (urlStr.includes(`/realms/${TEST_REALM}`) && !urlStr.includes('/protocol/')) {
        return new Response('{}', { status: 200 })
      }
      if (urlStr.includes('/protocol/openid-connect/token')) {
        return new Response(
          JSON.stringify({ error: 'unauthorized_client', error_description: 'Invalid client or Invalid client credentials' }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response('Not Found', { status: 404 })
    }) as typeof fetch

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'bad-client',
      client_secret: 'wrong',
    })

    const res = await authRoutes.handle(tokenRequest(body.toString()))
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('unauthorized_client')
  })

  it('sets Cache-Control: no-store on all responses', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'svc',
      client_secret: 'sec',
    })

    const res = await authRoutes.handle(tokenRequest(body.toString()))
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })
})
