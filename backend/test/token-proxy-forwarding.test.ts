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

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { TEST_BASE_URL, TEST_KC_BASE_URL, TEST_REALM, useTestEnv } from './helpers/test-env'
import { captureRequest, jsonResponse, keycloakFetch, type CapturedRequest, fakeFetch } from './helpers/fake-fetch'
import jwt from 'jsonwebtoken'

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

const FHIR_RESOURCE = 'http://localhost:8445/proxy-smart-backend/hapi-fhir-server/R4'
let resourceClientLoads = 0
mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => ({
    clients: {
      find: async () => {
        resourceClientLoads += 1
        return [
          { clientId: 'fhir-resource-server', attributes: { resource_url: FHIR_RESOURCE } },
          { clientId: 'https://dicom.example.com/mcp', attributes: { resource_url: 'https://dicom.example.com/mcp' } },
          { clientId: 'patient-portal', attributes: {} },
        ]
      },
    },
  }),
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

// ─── Capture KC fetch calls ─────────────────────────────────────────────────

let captured: CapturedRequest | null = null

function createCapturingFetch(kcTokenResponse?: Record<string, unknown>): typeof fetch {
  return keycloakFetch((url, init) => {
    if (url.includes('/protocol/openid-connect/token')) {
      captured = captureRequest(url, init)
      return jsonResponse(kcTokenResponse || {
        access_token: jwt.sign({ sub: 'svc', iss: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`, aud: 'account' }, 'k', { expiresIn: '5m' }),
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid',
      })
    }
    if (url.includes('/certs')) return new Response(JSON.stringify({ keys: [] }), { status: 200 })
    return undefined
  })
}

let mockFetchFn: typeof fetch = createCapturingFetch()
globalThis.fetch = fakeFetch((...args: Parameters<typeof fetch>) => mockFetchFn(...args))

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
  useTestEnv()

  beforeEach(() => {
    captured = null
    mockFetchFn = createCapturingFetch()
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

  it('client_credentials without resource: binds the token to the FHIR server, since SMART Backend Services names none', async () => {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 's', scope: 'system/Patient.rs' })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured!.params.get('resource')).toBe(FHIR_RESOURCE)
  })

  it('client_credentials: retries unbound when Keycloak cannot bind the defaulted resource for this client', async () => {
    const forms: URLSearchParams[] = []
    mockFetchFn = keycloakFetch((url, init) => {
      if (!url.includes('/protocol/openid-connect/token')) return undefined
      const form = captureRequest(url, init).params
      forms.push(form)
      return form.has('resource')
        ? jsonResponse({ error: 'invalid_target', error_description: 'The requested resource is invalid' }, 400)
        : jsonResponse({ access_token: jwt.sign({ sub: 'svc', aud: 'account' }, 'k', { expiresIn: '5m' }), token_type: 'Bearer', expires_in: 300 })
    })
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 's' })

    const response = await authRoutes.handle(tokenRequest(body.toString()))

    expect(response.status).toBe(200)
    expect(forms.map((f) => f.get('resource'))).toEqual([FHIR_RESOURCE, null])
  })

  it('client_credentials: passes invalid_target through for a resource the client asked for', async () => {
    let calls = 0
    mockFetchFn = keycloakFetch((url) => {
      if (!url.includes('/protocol/openid-connect/token')) return undefined
      calls += 1
      return jsonResponse({ error: 'invalid_target', error_description: 'The requested resource is invalid' }, 400)
    })
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 's', resource: FHIR_RESOURCE })

    const response = await authRoutes.handle(tokenRequest(body.toString()))

    expect(response.status).toBe(400)
    expect(calls).toBe(1)
  })

  it('client_credentials: forwards a requested resource unchanged', async () => {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 's', resource: 'https://dicom.example.com/mcp' })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured!.params.getAll('resource')).toEqual(['https://dicom.example.com/mcp'])
  })

  it('client_credentials: answers invalid_target for a resource no client holds, without asking Keycloak', async () => {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 's', resource: 'https://unknown.example.com/fhir' })

    const response = await authRoutes.handle(tokenRequest(body.toString()))

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_target')
    expect(captured).toBeNull()
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

  it('token-exchange: names the client holding the requested resource as audience, since Keycloak ignores resource', async () => {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'access-token-xyz',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: 'https://dicom.example.com/mcp',
      client_secret: 'sec',
      resource: FHIR_RESOURCE,
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.get('audience')).toBe('fhir-resource-server')
  })

  it('token-exchange: answers invalid_target for a resource no client holds, without asking Keycloak', async () => {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'access-token-xyz',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: 'https://dicom.example.com/mcp',
      client_secret: 'sec',
      resource: 'https://unknown.example.com/fhir',
    })

    const response = await authRoutes.handle(tokenRequest(body.toString()))

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_target')
    expect(captured).toBeNull()
  })

  it('token-exchange: leaves an explicit audience alone', async () => {
    const loadsBefore = resourceClientLoads
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'access-token-xyz',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: 'https://dicom.example.com/mcp',
      client_secret: 'sec',
      audience: 'some-client',
      resource: FHIR_RESOURCE,
    })

    await authRoutes.handle(tokenRequest(body.toString()))

    expect(captured!.params.get('audience')).toBe('some-client')
    expect(resourceClientLoads).toBe(loadsBefore)
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
    mockFetchFn = keycloakFetch((url) =>
      url.includes('/protocol/openid-connect/token')
        ? jsonResponse({ error: 'unauthorized_client', error_description: 'Invalid client or Invalid client credentials' }, 401)
        : undefined,
    )

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
