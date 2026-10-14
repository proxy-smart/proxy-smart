// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Device Authorization passthrough — TDD tests for POST /auth/device.
 *
 * The proxy fronts Keycloak's RFC 8628 device-authorization endpoint so CLI /
 * device clients begin the device grant at the proxy (where the discovery doc
 * points them) instead of talking to Keycloak directly. This forwards the
 * application/x-www-form-urlencoded body to Keycloak's
 * `.../protocol/openid-connect/auth/device` and returns the parsed JSON.
 *
 * Mirrors the cross-fetch mocking style of token-proxy-forwarding.test.ts so the
 * route's `import fetch from 'cross-fetch'` is intercepted (cross-fetch captures
 * globalThis.fetch at import time and ignores later swaps).
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { TEST_BASE_URL, TEST_KC_BASE_URL, TEST_REALM, omitTestEnv, useTestEnv } from './helpers/test-env'
import { captureRequest, fakeFetch, jsonResponse, type CapturedRequest } from './helpers/fake-fetch'

// ─── Mocks (must be before imports) ─────────────────────────────────────────

mockLoggerModule()

mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

// ─── Capture KC device-authorization fetch calls ────────────────────────────

let captured: CapturedRequest | null = null

const DEVICE_RESPONSE = {
  device_code: 'DEV-CODE-123',
  user_code: 'ABCD-EFGH',
  verification_uri: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}/device`,
  verification_uri_complete: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}/device?user_code=ABCD-EFGH`,
  expires_in: 600,
  interval: 5,
}

function createCapturingFetch(deviceResponse?: Record<string, unknown>, status = 200): typeof fetch {
  return fakeFetch((url, init) => {
    if (!url.includes('/protocol/openid-connect/auth/device')) return new Response('Not Found', { status: 404 })
    captured = captureRequest(url, init)
    return jsonResponse(deviceResponse || DEVICE_RESPONSE, status)
  })
}

let mockFetchFn: typeof fetch = createCapturingFetch()
mock.module('cross-fetch', () => ({
  default: (...args: Parameters<typeof fetch>) => mockFetchFn(...args),
}))

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { authRoutes } from '../src/routes/auth'

// ─── Helpers ────────────────────────────────────────────────────────────────

function deviceRequest(body: string): Request {
  return new Request(`${TEST_BASE_URL}/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /auth/device → KC device-authorization passthrough', () => {
  useTestEnv(omitTestEnv('KEYCLOAK_ADMIN_CLIENT_ID', 'KEYCLOAK_ADMIN_CLIENT_SECRET'))

  beforeEach(() => {
    captured = null
    mockFetchFn = createCapturingFetch()
  })

  it('forwards the form body to KC and returns the parsed device-authorization response', async () => {
    const body = new URLSearchParams({
      client_id: 'admin-cli',
      scope: 'openid profile email',
    })

    const res = await authRoutes.handle(deviceRequest(body.toString()))

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.device_code).toBe('DEV-CODE-123')
    expect(data.user_code).toBe('ABCD-EFGH')
    // verification_uri (KC's browser approval page) is passed through unchanged.
    expect(data.verification_uri).toBe(`${TEST_KC_BASE_URL}/realms/${TEST_REALM}/device`)

    // It targeted KC's device-authorization endpoint with the forwarded fields.
    expect(captured).not.toBeNull()
    expect(captured!.url).toContain('/protocol/openid-connect/auth/device')
    expect(captured!.params.get('client_id')).toBe('admin-cli')
    expect(captured!.params.get('scope')).toBe('openid profile email')
  })

  it('forwards a client_secret for confidential clients', async () => {
    const body = new URLSearchParams({
      client_id: 'svc',
      client_secret: 'shh',
      scope: 'openid',
    })

    await authRoutes.handle(deviceRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.get('client_secret')).toBe('shh')
  })

  it('does not inject a resource param (no SMART session for a device grant)', async () => {
    const body = new URLSearchParams({ client_id: 'admin-cli', scope: 'openid' })

    await authRoutes.handle(deviceRequest(body.toString()))

    expect(captured).not.toBeNull()
    expect(captured!.params.has('resource')).toBe(false)
  })

  it('sets Cache-Control: no-store on the response', async () => {
    const res = await authRoutes.handle(
      deviceRequest(new URLSearchParams({ client_id: 'admin-cli' }).toString()),
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })

  it('propagates the upstream status and error body when KC rejects the request', async () => {
    mockFetchFn = createCapturingFetch(
      { error: 'invalid_client', error_description: 'Invalid client credentials' },
      401,
    )

    const res = await authRoutes.handle(
      deviceRequest(new URLSearchParams({ client_id: 'bogus' }).toString()),
    )

    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('invalid_client')
    expect(data.error_description).toBe('Invalid client credentials')
  })

  it('returns an RFC 6749 server_error when the upstream call throws', async () => {
    mockFetchFn = fakeFetch(() => {
      throw new Error('network down')
    })

    const res = await authRoutes.handle(
      deviceRequest(new URLSearchParams({ client_id: 'admin-cli' }).toString()),
    )

    expect(res.status).toBe(500)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const data = await res.json()
    expect(data.error).toBe('server_error')
  })
})
