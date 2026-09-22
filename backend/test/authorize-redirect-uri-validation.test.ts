// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Authorize / Callback redirect_uri allowlist — backend wiring (security)
 *
 * VULN 1 (CRITICAL): Authorization-code theft via unvalidated redirect_uri.
 *
 * Verifies that the backend oauth routes pass a working
 * `getRegisteredRedirectUris` dependency into @proxy-smart/auth so that:
 *   - GET /auth/authorize rejects a redirect_uri that is not registered for
 *     the client (no session created, no redirect to Keycloak).
 *   - GET /auth/smart-callback refuses to forward the auth code to a stored
 *     redirect_uri that is not registered (defense in depth).
 *   - A registered redirect_uri still flows through normally.
 *
 * The Keycloak admin lookup behind getRegisteredRedirectUris is mocked at the
 * smart-client-config-cache layer so no live Keycloak is required.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'

// ─── Test Constants ─────────────────────────────────────────────────────────

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_KC_BASE_URL = 'http://localhost:8080'
const TEST_REALM = 'smart-health'
const TEST_LAUNCH_SECRET = 'test-launch-secret-32-bytes-long!'
const TEST_CLIENT_ID = 'smart-app-client'
const REGISTERED_REDIRECT = 'http://localhost:3000/callback'
const ATTACKER_REDIRECT = 'https://attacker.evil/steal'

const CONFIG_ENV_VARS = {
  BASE_URL: TEST_BASE_URL,
  SMART_LAUNCH_SECRET: TEST_LAUNCH_SECRET,
  SMART_LAUNCH_CODE_TTL_SECONDS: '300',
  KEYCLOAK_BASE_URL: TEST_KC_BASE_URL,
  KEYCLOAK_REALM: TEST_REALM,
  KEYCLOAK_PUBLIC_URL: TEST_KC_BASE_URL,
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret',
  FHIR_BASE_URL: 'http://localhost:8081/fhir',
  PROXY_NAME: 'fhir',
} as const

mockLoggerModule()

mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

// Keycloak reachable + token mock via cross-fetch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockFetchFn: (...args: any[]) => Promise<Response> = async () => new Response('{}', { status: 200 })
mock.module('cross-fetch', () => ({
  default: (...args: Parameters<typeof fetch>) => mockFetchFn(...args),
}))

mock.module('@/lib/kc-session-resolver', () => ({
  autoResolvePatient: async () => null,
}))

mock.module('@/lib/auth', () => ({
  validateToken: async () => ({ sub: 'test-user' }),
}))

// Mock the Keycloak admin lookup behind getRegisteredRedirectUris so the
// allowlist is deterministic without a live Keycloak.
let registeredUris: string[] = [REGISTERED_REDIRECT]
mock.module('@/lib/smart-client-config-cache', () => ({
  getSmartClientConfig: async () => ({ redirectUris: registeredUris }),
  getRegisteredRedirectUris: async (clientId: string) =>
    clientId === TEST_CLIENT_ID ? registeredUris : [],
  invalidateClientConfig: () => {},
  clearClientConfigCache: () => {},
}))

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { authRoutes } from '../src/routes/auth'
import { launchContextStore, type LaunchSession } from '../src/lib/launch-context-store'

function authRequest(path: string, init?: RequestInit): Request {
  return new Request(`${TEST_BASE_URL}${path}`, init)
}

function createKcReachableFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (urlStr.includes(`/realms/${TEST_REALM}`) && !urlStr.includes('/protocol/')) {
      return new Response('{}', { status: 200 })
    }
    return new Response('Not Found', { status: 404 })
  }) as typeof fetch
}

function createSession(overrides?: Partial<LaunchSession>): [string, LaunchSession] {
  const key = crypto.randomUUID()
  const session: LaunchSession = {
    clientRedirectUri: REGISTERED_REDIRECT,
    clientState: 'original-state',
    clientId: TEST_CLIENT_ID,
    scope: 'openid launch/patient patient/*.read',
    needsPatientPicker: false,
    patient: 'Patient/123',
    createdAt: Date.now(),
    ...overrides,
  }
  launchContextStore.set(key, session)
  return [key, session]
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('VULN 1 — redirect_uri allowlist (backend wiring)', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    mockFetchFn = createKcReachableFetch()
    registeredUris = [REGISTERED_REDIRECT]
  })

  afterEach(() => {
    for (const key of Object.keys(CONFIG_ENV_VARS)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFetchFn = async () => new Response('{}', { status: 200 }) as any
    launchContextStore.dispose()
  })

  it('GET /auth/authorize rejects an unregistered redirect_uri (no session, no KC redirect)', async () => {
    const res = await authRoutes.handle(authRequest(
      `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(ATTACKER_REDIRECT)}&scope=openid+launch/patient+patient/*.read&state=s`
    ))

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('invalid_request')
    // No session should have been created for the attacker URI.
    expect(launchContextStore.size()).toBe(0)
  })

  it('GET /auth/authorize accepts a registered redirect_uri and intercepts normally', async () => {
    const res = await authRoutes.handle(authRequest(
      `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(REGISTERED_REDIRECT)}&scope=openid+launch/patient+patient/*.read&state=s`
    ))

    expect(res.status).toBe(302)
    const kcUrl = new URL(res.headers.get('location')!)
    // Interception preserved: KC gets the proxy callback, a session exists.
    expect(kcUrl.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}/auth/smart-callback`)
    expect(launchContextStore.size()).toBe(1)
  })

  it('GET /auth/smart-callback refuses to forward the code to an unregistered stored redirect_uri', async () => {
    const [sessionKey] = createSession({ clientRedirectUri: ATTACKER_REDIRECT })

    const res = await authRoutes.handle(authRequest(
      `/auth/smart-callback?code=stolen-code&state=${sessionKey}`
    ))

    // Must NOT 302 the code to attacker.evil — must surface an error page instead.
    expect(res.status).not.toBe(302)
    const location = res.headers.get('location')
    if (location) expect(location).not.toContain('attacker.evil')
  })

  it('GET /auth/smart-callback forwards the code to a registered stored redirect_uri', async () => {
    const [sessionKey] = createSession({ clientRedirectUri: REGISTERED_REDIRECT })

    const res = await authRoutes.handle(authRequest(
      `/auth/smart-callback?code=good-code&state=${sessionKey}`
    ))

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe(REGISTERED_REDIRECT)
    expect(location.searchParams.get('code')).toBe('good-code')
  })
})
