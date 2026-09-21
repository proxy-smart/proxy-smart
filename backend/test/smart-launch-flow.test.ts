// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART Launch Flow Integration Tests
 *
 * Tests the full SMART on FHIR STU 2.2.0 launch context flow:
 *   GET /auth/authorize  → intercepts SMART scopes, creates session, rewrites redirect_uri
 *   GET /auth/smart-callback → resolves session, forwards code to client
 *   GET /auth/patient-select → serves picker when needed
 *   POST /auth/patient-select → submits patient selection
 *   POST /auth/token → correlates session, enriches response with context
 *
 * These tests exercise the Elysia app directly (no HTTP server needed) via
 * `authRoutes.handle(new Request(...))`. Keycloak network calls are mocked
 * via mock.module('cross-fetch').
 *
 * Bug vectors targeted:
 *   - Session not found at callback (expired, wrong key)
 *   - Redirect URI rewrite for KC token exchange
 *   - Patient picker bypass without valid session
 *   - Concurrent sessions for same client don't interfere
 *   - Original state preservation through the chain
 *   - Session consumed at token time (no reuse)
 *   - Non-SMART scopes bypass interception entirely
 *   - EHR launch code pre-populates session context
 *   - Scope gating: launch/patient required to emit patient in token response
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import jwt from 'jsonwebtoken'

// ─── Test Constants ─────────────────────────────────────────────────────────

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_KC_BASE_URL = 'http://localhost:8080'
const TEST_REALM = 'smart-health'
const TEST_LAUNCH_SECRET = 'test-launch-secret-32-bytes-long!'
const TEST_CLIENT_ID = 'smart-app-client'
const TEST_CLIENT_REDIRECT = 'http://localhost:3000/callback'
const TEST_PATIENT_ID = 'Patient/test-patient-123'
const TEST_PATIENT_LOGICAL_ID = 'test-patient-123' // What token response returns (spec: logical ID only)
const TEST_ENCOUNTER_ID = 'Encounter/test-encounter-456'
const TEST_ENCOUNTER_LOGICAL_ID = 'test-encounter-456' // What token response returns (spec: logical ID only)
const TEST_FHIR_BASE = `${TEST_BASE_URL}/proxy-smart-backend/hapi-fhir-server/R4`

// ─── Environment Setup ──────────────────────────────────────────────────────

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

// Mock OAuth metrics logger to avoid file system operations
mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

// Mock cross-fetch so oauth.ts uses our controlled fetch
// This is critical because oauth.ts does `import fetch from 'cross-fetch'`
// which is NOT globalThis.fetch in Bun.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockFetchFn: (...args: any[]) => Promise<Response> = async () => new Response('{}', { status: 200 })
mock.module('cross-fetch', () => ({
  default: (...args: Parameters<typeof fetch>) => mockFetchFn(...args),
}))

// Mock kc-session-resolver — the real implementation needs a live Keycloak admin API.
// Tests control the return value via mockAutoResolvePatient.
let mockAutoResolvePatient: (() => Promise<string | null>) = async () => null
mock.module('@/lib/kc-session-resolver', () => ({
  autoResolvePatient: async (..._args: unknown[]) => mockAutoResolvePatient(),
}))

// Mock validateToken — we don't have real JWKS in tests
mock.module('@/lib/auth', () => ({
  validateToken: async (token: string) => {
    // Decode without verification for test purposes
    const parts = token.split('.')
    if (parts.length === 3) {
      try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString())
      } catch { /* fall through */ }
    }
    return { sub: 'test-user' }
  },
}))

// Mock the Keycloak admin lookup behind getRegisteredRedirectUris (VULN 1 fix).
// The redirect_uri allowlist is validated at authorize/callback time. These
// integration tests use a fixed set of legitimate client redirect URIs; the
// real lookup needs a live Keycloak admin API, so we return the allowlist
// directly here. getSmartClientConfig is kept intact for fhirUser resolution.
const ALLOWED_REDIRECT_URIS = [
  'http://localhost:3000/callback', // TEST_CLIENT_REDIRECT
  'http://app-a.local/callback',
  'http://app-b.local/callback',
]
mock.module('@/lib/smart-client-config-cache', () => ({
  getSmartClientConfig: async () => ({ patientFacing: undefined, redirectUris: ALLOWED_REDIRECT_URIS }),
  getRegisteredRedirectUris: async () => ALLOWED_REDIRECT_URIS,
  invalidateClientConfig: () => {},
  clearClientConfigCache: () => {},
}))

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { authRoutes } from '../src/routes/auth'
import { launchContextStore, type LaunchSession } from '../src/lib/launch-context-store'
import { signLaunchCode as signLaunchCodeWith, toLaunchCodeOptions, type LaunchCodePayload } from '@proxy-smart/auth'
import { smartProxyConfig, smartLogger } from '../src/routes/auth/smart-proxy-setup'

const signLaunchCode = (payload: LaunchCodePayload) =>
  signLaunchCodeWith(payload, toLaunchCodeOptions(smartProxyConfig, smartLogger))

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a Request to the auth routes with the /auth prefix */
function authRequest(path: string, init?: RequestInit): Request {
  return new Request(`${TEST_BASE_URL}${path}`, init)
}

/** Create a mock fetch that simulates Keycloak being reachable */
function createKcReachableFetch(tokenResponse?: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request, _opts?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url

    // KC realm check (isKeycloakReachable)
    if (urlStr.includes(`/realms/${TEST_REALM}`) && !urlStr.includes('/protocol/')) {
      return new Response('{}', { status: 200 })
    }

    // KC token endpoint
    if (urlStr.includes('/protocol/openid-connect/token')) {
      const resp = tokenResponse || {
        access_token: createMockAccessToken(),
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
        id_token: 'mock-id-token',
      }
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    // KC introspect endpoint
    if (urlStr.includes('/protocol/openid-connect/token/introspect')) {
      return new Response(JSON.stringify({ active: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    // KC JWKS endpoint
    if (urlStr.includes('/protocol/openid-connect/certs')) {
      return new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    // Default: 404
    return new Response('Not Found', { status: 404 })
  }) as typeof fetch
}

/** Create a mock JWT access_token (unsigned, for test purposes) */
function createMockAccessToken(claims?: Record<string, unknown>): string {
  return jwt.sign(
    {
      sub: 'user-123',
      iss: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`,
      aud: 'account',
      fhirUser: 'Practitioner/dr-smith',
      smart_scope: 'openid launch/patient patient/*.read',
      ...claims,
    },
    'test-secret',
    { expiresIn: '5m' }
  )
}

/** Create a session manually for testing endpoints that expect one */
function createTestSession(overrides?: Partial<LaunchSession>): [string, LaunchSession] {
  const key = crypto.randomUUID()
  const session: LaunchSession = {
    clientRedirectUri: TEST_CLIENT_REDIRECT,
    clientState: 'original-state-abc',
    clientId: TEST_CLIENT_ID,
    scope: 'openid launch/patient patient/*.read',
    aud: TEST_FHIR_BASE,
    createdAt: Date.now(),
    ...overrides,
  }
  launchContextStore.set(key, session)
  return [key, session]
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe('SMART Launch Flow Integration', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Set env vars
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    // Set mock fetch for KC reachability (used by cross-fetch mock)
    mockFetchFn = createKcReachableFetch()
  })

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(CONFIG_ENV_VARS)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    // Reset mock fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFetchFn = async () => new Response('{}', { status: 200 }) as any
    // Clear all sessions between tests
    launchContextStore.dispose()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /auth/authorize — Session creation and redirect_uri interception
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /auth/authorize — SMART session interception', () => {
    it('intercepts when scope contains launch/patient and creates a session', async () => {
      const res = await authRoutes.handle(authRequest(
        `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_CLIENT_REDIRECT)}&scope=openid+launch/patient+patient/*.read&state=my-state`
      ))

      // Should redirect to Keycloak
      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      expect(location).toContain(`${TEST_KC_BASE_URL}/realms/${TEST_REALM}/protocol/openid-connect/auth`)

      // redirect_uri should be rewritten to proxy's callback
      const kcUrl = new URL(location)
      expect(kcUrl.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}/auth/smart-callback`)

      // state should be replaced with a UUID session key (not 'my-state')
      const sessionKey = kcUrl.searchParams.get('state')!
      expect(sessionKey).not.toBe('my-state')
      expect(sessionKey).toMatch(/^[0-9a-f-]{36}$/)

      // Verify session was stored with the original redirect_uri and state
      const session = launchContextStore.get(sessionKey)
      expect(session).not.toBeNull()
      expect(session!.clientRedirectUri).toBe(TEST_CLIENT_REDIRECT)
      expect(session!.clientState).toBe('my-state')
      expect(session!.clientId).toBe(TEST_CLIENT_ID)
      expect(session!.needsPatientPicker).toBe(true) // standalone launch
    })

    it('intercepts when scope contains launch (EHR launch without code)', async () => {
      const res = await authRoutes.handle(authRequest(
        `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_CLIENT_REDIRECT)}&scope=openid+launch+patient/*.read&state=ehr-state`
      ))

      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      const kcUrl = new URL(location)
      expect(kcUrl.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}/auth/smart-callback`)

      const sessionKey = kcUrl.searchParams.get('state')!
      const session = launchContextStore.get(sessionKey)
      expect(session).not.toBeNull()
      expect(session!.clientState).toBe('ehr-state')
    })

    it('does NOT intercept when no SMART scopes are present', async () => {
      const res = await authRoutes.handle(authRequest(
        `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_CLIENT_REDIRECT)}&scope=openid+profile+email&state=plain-state`
      ))

      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      const kcUrl = new URL(location)

      // redirect_uri should pass through unchanged — no interception
      expect(kcUrl.searchParams.get('redirect_uri')).toBe(TEST_CLIENT_REDIRECT)
      // state should pass through unchanged
      expect(kcUrl.searchParams.get('state')).toBe('plain-state')
      // No session created
      expect(launchContextStore.size()).toBe(0)
    })

    it('does NOT intercept when redirect_uri is missing', async () => {
      const res = await authRoutes.handle(authRequest(
        `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&scope=openid+launch/patient&state=no-redir`
      ))

      // Should still redirect to KC (just no interception)
      expect(res.status).toBe(302)
      // No session created because redirect_uri was empty
      expect(launchContextStore.size()).toBe(0)
    })

    it('preserves PKCE code_challenge in session for passthrough', async () => {
      const res = await authRoutes.handle(authRequest(
        `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_CLIENT_REDIRECT)}&scope=openid+launch/patient&state=pkce-state&code_challenge=abc123&code_challenge_method=S256`
      ))

      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      const kcUrl = new URL(location)
      const sessionKey = kcUrl.searchParams.get('state')!

      const session = launchContextStore.get(sessionKey)
      expect(session).not.toBeNull()
      expect(session!.codeChallenge).toBe('abc123')
      expect(session!.codeChallengeMethod).toBe('S256')

      // PKCE params should also be forwarded to KC
      expect(kcUrl.searchParams.get('code_challenge')).toBe('abc123')
      expect(kcUrl.searchParams.get('code_challenge_method')).toBe('S256')
    })

    it('pre-populates session from valid EHR launch code', async () => {
      const launchCode = signLaunchCode({
        patient: TEST_PATIENT_ID,
        encounter: TEST_ENCOUNTER_ID,
        fhirUser: 'Practitioner/dr-smith',
        intent: 'order-review',
      })

      const res = await authRoutes.handle(authRequest(
        `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_CLIENT_REDIRECT)}&scope=openid+launch+patient/*.read&state=ehr-code-state&launch=${launchCode}`
      ))

      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      const kcUrl = new URL(location)
      const sessionKey = kcUrl.searchParams.get('state')!

      const session = launchContextStore.get(sessionKey)
      expect(session).not.toBeNull()
      expect(session!.patient).toBe(TEST_PATIENT_ID)
      expect(session!.encounter).toBe(TEST_ENCOUNTER_ID)
      expect(session!.fhirUser).toBe('Practitioner/dr-smith')
      expect(session!.intent).toBe('order-review')
      // EHR launch with patient set → no picker needed
      expect(session!.needsPatientPicker).toBe(false)
    })

    it('sets needsPatientPicker=true for standalone launch without EHR code', async () => {
      const res = await authRoutes.handle(authRequest(
        `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_CLIENT_REDIRECT)}&scope=openid+launch/patient+patient/*.read&state=standalone`
      ))

      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      const sessionKey = new URL(location).searchParams.get('state')!

      const session = launchContextStore.get(sessionKey)
      expect(session!.needsPatientPicker).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /auth/smart-callback — KC callback handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /auth/smart-callback — session resolution', () => {
    it('redirects to client with code and original state when session is valid', async () => {
      const [sessionKey] = createTestSession({ needsPatientPicker: false, patient: TEST_PATIENT_ID })

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=auth-code-xyz&state=${sessionKey}`
      ))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.origin + location.pathname).toBe(TEST_CLIENT_REDIRECT)
      expect(location.searchParams.get('code')).toBe('auth-code-xyz')
      expect(location.searchParams.get('state')).toBe('original-state-abc')
    })

    it('returns 400 when session key is missing', async () => {
      const res = await authRoutes.handle(authRequest('/auth/smart-callback?code=abc'))

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('invalid_request')
      expect(html).toContain('Missing state')
    })

    it('returns 400 when session expired or invalid key', async () => {
      const res = await authRoutes.handle(authRequest(
        '/auth/smart-callback?code=abc&state=non-existent-session-key'
      ))

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('invalid_request')
      expect(html).toContain('expired')
    })

    it('forwards KC errors to client redirect_uri with original state', async () => {
      const [sessionKey] = createTestSession()

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?error=access_denied&error_description=User+denied+consent&state=${sessionKey}`
      ))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.origin + location.pathname).toBe(TEST_CLIENT_REDIRECT)
      expect(location.searchParams.get('error')).toBe('access_denied')
      expect(location.searchParams.get('error_description')).toBe('User denied consent')
      expect(location.searchParams.get('state')).toBe('original-state-abc')

      // Session should be consumed (deleted) after error forwarding
      expect(launchContextStore.get(sessionKey)).toBeNull()
    })

    it('redirects to patient picker when needsPatientPicker=true and no patient set', async () => {
      // A practitioner: the picker is theirs alone, so the fixture must say who the user is.
      const [sessionKey] = createTestSession({ needsPatientPicker: true, fhirUser: 'Practitioner/dr-smith' })

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=picker-code&state=${sessionKey}`
      ))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.pathname).toBe('/patient-picker/')
      expect(location.searchParams.get('session')).toBe(sessionKey)
      expect(location.searchParams.get('code')).toBe('picker-code')
      expect(location.searchParams.get('aud')).toBe(TEST_FHIR_BASE)
    })

    it('does NOT redirect to picker when needsPatientPicker=true but patient already set', async () => {
      const [sessionKey] = createTestSession({
        needsPatientPicker: true,
        patient: 'Patient/already-set',
      })

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=skip-picker-code&state=${sessionKey}`
      ))

      // Should go straight to client (no picker needed — patient pre-populated)
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.origin + location.pathname).toBe(TEST_CLIENT_REDIRECT)
      expect(location.searchParams.get('code')).toBe('skip-picker-code')
    })

    it('returns 400 when code is missing and no error', async () => {
      const [sessionKey] = createTestSession()

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?state=${sessionKey}`
      ))

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('invalid_request')
      expect(html).toContain('Missing authorization code')
    })

    it('auto-resolves patient and skips picker when fhirUser is Patient/*', async () => {
      const [sessionKey] = createTestSession({ needsPatientPicker: true })

      // Simulate a Patient user logging in — auto-resolve returns their patient ID
      mockAutoResolvePatient = async () => 'jane-123'

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=patient-code&state=${sessionKey}&session_state=kc-session-xyz`
      ))

      // Should skip picker and go straight to client
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.origin + location.pathname).toBe(TEST_CLIENT_REDIRECT)
      expect(location.searchParams.get('code')).toBe('patient-code')

      // Session should have patient auto-set
      const updatedSession = launchContextStore.get(sessionKey)
      expect(updatedSession?.patient).toBe('jane-123')
      expect(updatedSession?.needsPatientPicker).toBe(false)

      // Cleanup
      mockAutoResolvePatient = async () => null
    })

    it('falls through to picker when the user is a practitioner', async () => {
      const [sessionKey] = createTestSession({ needsPatientPicker: true, fhirUser: 'Practitioner/dr-smith' })

      // Practitioner user — auto-resolve returns null (not a Patient)
      mockAutoResolvePatient = async () => null

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=pract-code&state=${sessionKey}&session_state=kc-session-pract`
      ))

      // Practitioner → still needs picker
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.pathname).toBe('/patient-picker/')
      expect(location.searchParams.get('session')).toBe(sessionKey)
    })

    it('refuses the picker when the identity is not a practitioner', async () => {
      /*
       * THE HOLE. An identity we cannot place used to reach a searchable directory of every patient.
       * "No resolved patient" is not evidence of being a clinician, so this now fails closed.
       */
      const [sessionKey] = createTestSession({ needsPatientPicker: true })
      mockAutoResolvePatient = async () => null

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=unknown-code&state=${sessionKey}&session_state=kc-session-unknown`
      ))

      expect(res.status).toBe(403)
      const session = launchContextStore.get(sessionKey)
      expect(session?.pickerAllowed).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Patient Picker endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Patient Picker — GET & POST /auth/patient-select', () => {
    it('GET redirects to patient picker app when the session was cleared for it', async () => {
      // `pickerAllowed` is what the callback gate sets after establishing a practitioner.
      const [sessionKey] = createTestSession({ needsPatientPicker: true, pickerAllowed: true })

      const res = await authRoutes.handle(authRequest(
        `/auth/patient-select?session=${sessionKey}&code=the-code`
      ))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.pathname).toBe('/patient-picker/')
      expect(location.searchParams.get('session')).toBe(sessionKey)
      expect(location.searchParams.get('code')).toBe('the-code')
      expect(location.searchParams.get('aud')).toBe(TEST_FHIR_BASE)
    })

    it('GET redirects to patient-picker with error when session param is missing', async () => {
      const res = await authRoutes.handle(authRequest('/auth/patient-select?code=abc'))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.pathname).toBe('/patient-picker/')
      expect(location.searchParams.get('error')).toBe('invalid_request')
    })

    it('GET redirects to patient-picker with error when code param is missing', async () => {
      const [sessionKey] = createTestSession()
      const res = await authRoutes.handle(authRequest(
        `/auth/patient-select?session=${sessionKey}`
      ))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.pathname).toBe('/patient-picker/')
      expect(location.searchParams.get('error')).toBe('invalid_request')
    })

    it('GET refuses the picker app when the session was never cleared for it', async () => {
      // Defence in depth: the gate lives in the callback, and this endpoint does not take its word.
      const [sessionKey] = createTestSession({ needsPatientPicker: true })

      const res = await authRoutes.handle(authRequest(
        `/auth/patient-select?session=${sessionKey}&code=the-code`
      ))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.searchParams.get('error')).toBe('access_denied')
    })

    it('GET redirects to patient-picker with error when session is expired/invalid', async () => {
      const res = await authRoutes.handle(authRequest(
        '/auth/patient-select?session=invalid-key&code=abc'
      ))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.pathname).toBe('/patient-picker/')
      expect(location.searchParams.get('error')).toBe('session_expired')
      expect(location.searchParams.get('error_description')).toContain('expired')
    })

    it('POST updates session with patient and redirects to client', async () => {
      const [sessionKey] = createTestSession({ needsPatientPicker: true })

      const formBody = new URLSearchParams({
        session: sessionKey,
        code: 'auth-code-from-kc',
        patient: TEST_PATIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/patient-select', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.origin + location.pathname).toBe(TEST_CLIENT_REDIRECT)
      expect(location.searchParams.get('code')).toBe('auth-code-from-kc')
      expect(location.searchParams.get('state')).toBe('original-state-abc')

      // Verify session was updated
      const session = launchContextStore.get(sessionKey)
      expect(session).not.toBeNull()
      expect(session!.patient).toBe(TEST_PATIENT_ID)
      expect(session!.needsPatientPicker).toBe(false)
    })

    it('POST returns 400 when session is missing', async () => {
      const formBody = new URLSearchParams({
        code: 'abc',
        patient: TEST_PATIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/patient-select', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(400)
    })

    it('POST returns 400 when patient is missing', async () => {
      const [sessionKey] = createTestSession()
      const formBody = new URLSearchParams({
        session: sessionKey,
        code: 'abc',
      })

      const res = await authRoutes.handle(authRequest('/auth/patient-select', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(400)
    })

    it('POST returns 400 when session is expired/invalid', async () => {
      const formBody = new URLSearchParams({
        session: 'expired-key',
        code: 'abc',
        patient: TEST_PATIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/patient-select', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(400)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /auth/token — Session correlation, redirect_uri rewrite, enrichment
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /auth/token — session-based context enrichment', () => {
    // These tests share mutable state via launchContextStore and must run sequentially
    it.serial('enriches token response with patient from session (launch/patient scope)', async () => {
      // Create a session that would exist after /smart-callback
      createTestSession({
        patient: TEST_PATIENT_ID,
        needsPatientPicker: false,
      })

      // Mock KC token response (valid JWT)
      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient patient/*.read' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient patient/*.read',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'kc-auth-code',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.patient).toBe(TEST_PATIENT_LOGICAL_ID)
      expect(data.access_token).toBeTruthy()
    })

    it.serial('enriches with encounter when launch/encounter scope is granted', async () => {
      createTestSession({
        patient: TEST_PATIENT_ID,
        encounter: TEST_ENCOUNTER_ID,
        needsPatientPicker: false,
        scope: 'openid launch/patient launch/encounter',
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient launch/encounter' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient launch/encounter',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'kc-auth-code-enc',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.patient).toBe(TEST_PATIENT_LOGICAL_ID)
      expect(data.encounter).toBe(TEST_ENCOUNTER_LOGICAL_ID)
    })

    it.serial('does NOT emit patient when launch/patient scope is not granted', async () => {
      createTestSession({
        patient: TEST_PATIENT_ID,
        needsPatientPicker: false,
        scope: 'openid profile',
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid profile' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid profile',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'kc-auth-code-noscope',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      // Patient should NOT be in response — scope gating prevents it
      expect(data.patient).toBeUndefined()
    })

    it.serial('consumes session after token exchange (no reuse)', async () => {
      const [sessionKey] = createTestSession({
        patient: TEST_PATIENT_ID,
        needsPatientPicker: false,
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'consume-test-code',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      // First call — should succeed and consume session
      const res1 = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))
      expect(res1.status).toBe(200)
      const data1 = await res1.json()
      expect(data1.patient).toBe(TEST_PATIENT_LOGICAL_ID)

      // Session should be consumed (deleted)
      expect(launchContextStore.get(sessionKey)).toBeNull()

      // Second call — session gone, no patient enrichment
      const res2 = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))
      expect(res2.status).toBe(200)
      const data2 = await res2.json()
      expect(data2.patient).toBeUndefined()
    })

    it.serial('rewrites redirect_uri to proxy callback for KC token exchange', async () => {
      createTestSession({
        patient: TEST_PATIENT_ID,
        needsPatientPicker: false,
      })

      // Capture what redirect_uri was sent to KC
      let capturedRedirectUri: string | null = null
      mockFetchFn = (async (url: string | URL | Request, opts?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url

        // KC realm check
        if (urlStr.includes(`/realms/${TEST_REALM}`) && !urlStr.includes('/protocol/')) {
          return new Response('{}', { status: 200 })
        }

        // KC token endpoint — capture the body
        if (urlStr.includes('/protocol/openid-connect/token')) {
          const body = opts?.body?.toString() || ''
          const params = new URLSearchParams(body)
          capturedRedirectUri = params.get('redirect_uri')

          const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient' })
          return new Response(JSON.stringify({
            access_token: mockToken,
            token_type: 'Bearer',
            expires_in: 300,
            scope: 'openid launch/patient',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

        return new Response('Not Found', { status: 404 })
      }) as typeof fetch

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'rewrite-test-code',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      // The redirect_uri sent to KC should be the proxy's smart-callback, not the client's
      expect(capturedRedirectUri!).toBe(`${TEST_BASE_URL}/auth/smart-callback`)
    })

    it.serial('does NOT rewrite redirect_uri when no session matches', async () => {
      // No session created — direct token exchange (non-SMART flow)
      let capturedRedirectUri: string | null = null
      mockFetchFn = (async (url: string | URL | Request, opts?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url

        if (urlStr.includes(`/realms/${TEST_REALM}`) && !urlStr.includes('/protocol/')) {
          return new Response('{}', { status: 200 })
        }
        if (urlStr.includes('/protocol/openid-connect/token')) {
          const body = opts?.body?.toString() || ''
          const params = new URLSearchParams(body)
          capturedRedirectUri = params.get('redirect_uri')

          return new Response(JSON.stringify({
            access_token: createMockAccessToken(),
            token_type: 'Bearer',
            expires_in: 300,
            scope: 'openid profile',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('Not Found', { status: 404 })
      }) as typeof fetch

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'no-session-code',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      // Should pass through unchanged — no session to rewrite for
      expect(capturedRedirectUri!).toBe(TEST_CLIENT_REDIRECT)
    })

    it.serial('includes Cache-Control: no-store header per RFC 6749', async () => {
      const mockToken = createMockAccessToken()
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'cache-test',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('pragma')).toBe('no-cache')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Concurrent Sessions — Race Condition Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Concurrent sessions — isolation', () => {
    it.serial('two sessions for same client with different redirect_uris resolve independently', async () => {
      const REDIRECT_A = 'http://app-a.local/callback'
      const REDIRECT_B = 'http://app-b.local/callback'

      createTestSession({
        clientRedirectUri: REDIRECT_A,
        patient: 'Patient/alice',
        needsPatientPicker: false,
      })
      createTestSession({
        clientRedirectUri: REDIRECT_B,
        patient: 'Patient/bob',
        needsPatientPicker: false,
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
      })

      // Token request for redirect A
      const resA = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'code-a',
          redirect_uri: REDIRECT_A,
          client_id: TEST_CLIENT_ID,
        }).toString(),
      }))
      const dataA = await resA.json()
      expect(dataA.patient).toBe('alice')

      // Token request for redirect B
      const resB = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'code-b',
          redirect_uri: REDIRECT_B,
          client_id: TEST_CLIENT_ID,
        }).toString(),
      }))
      const dataB = await resB.json()
      expect(dataB.patient).toBe('bob')
    })

    it.serial('two sessions for different clients with same redirect_uri resolve independently', async () => {
      createTestSession({
        clientId: 'client-x',
        patient: 'Patient/x-patient',
        needsPatientPicker: false,
      })
      createTestSession({
        clientId: 'client-y',
        patient: 'Patient/y-patient',
        needsPatientPicker: false,
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
      })

      const resX = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'code-x',
          redirect_uri: TEST_CLIENT_REDIRECT,
          client_id: 'client-x',
        }).toString(),
      }))
      const dataX = await resX.json()
      expect(dataX.patient).toBe('x-patient')

      const resY = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'code-y',
          redirect_uri: TEST_CLIENT_REDIRECT,
          client_id: 'client-y',
        }).toString(),
      }))
      const dataY = await resY.json()
      expect(dataY.patient).toBe('y-patient')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Full Flow — end-to-end chain
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Full flow — authorize → callback → token', () => {
    it.serial('standalone launch: authorize → callback → picker → token with patient', async () => {
      // Step 1: Authorize — creates session, rewrites redirect_uri
      const authorizeRes = await authRoutes.handle(authRequest(
        `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_CLIENT_REDIRECT)}&scope=openid+launch/patient+patient/*.read&state=e2e-state&aud=${encodeURIComponent(TEST_FHIR_BASE)}`
      ))
      expect(authorizeRes.status).toBe(302)
      const kcRedirect = new URL(authorizeRes.headers.get('location')!)
      const sessionKey = kcRedirect.searchParams.get('state')!

      /*
       * The real resolver writes fhirUser onto the session while looking for a patient
       * (kc-session-resolver), and the picker gate reads it. Simulate a practitioner signing in.
       */
      launchContextStore.update(sessionKey, { fhirUser: 'Practitioner/dr-smith' })

      // Step 2: Simulate KC callback to /smart-callback with auth code
      const callbackRes = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=e2e-auth-code&state=${sessionKey}`
      ))
      expect(callbackRes.status).toBe(302)
      const pickerUrl = new URL(callbackRes.headers.get('location')!)
      expect(pickerUrl.pathname).toBe('/patient-picker/')
      expect(pickerUrl.searchParams.get('session')).toBe(sessionKey)

      // Step 3: Patient picker submission
      const pickerRes = await authRoutes.handle(authRequest('/auth/patient-select', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          session: sessionKey,
          code: 'e2e-auth-code',
          patient: TEST_PATIENT_ID,
        }).toString(),
      }))
      expect(pickerRes.status).toBe(302)
      const clientRedirect = new URL(pickerRes.headers.get('location')!)
      expect(clientRedirect.origin + clientRedirect.pathname).toBe(TEST_CLIENT_REDIRECT)
      expect(clientRedirect.searchParams.get('state')).toBe('e2e-state')
      expect(clientRedirect.searchParams.get('code')).toBe('e2e-auth-code')

      // Step 4: Token exchange — session enriches response
      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient patient/*.read' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient patient/*.read',
      })

      const tokenRes = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'e2e-auth-code',
          redirect_uri: TEST_CLIENT_REDIRECT,
          client_id: TEST_CLIENT_ID,
        }).toString(),
      }))
      expect(tokenRes.status).toBe(200)
      const tokenData = await tokenRes.json()
      expect(tokenData.patient).toBe(TEST_PATIENT_LOGICAL_ID)
      expect(tokenData.access_token).toBeTruthy()

      // Session should be consumed
      expect(launchContextStore.get(sessionKey)).toBeNull()
    })

    it.serial('EHR launch: authorize with code → callback → token with pre-populated context', async () => {
      // Issue a launch code
      const launchCode = signLaunchCode({
        patient: TEST_PATIENT_ID,
        encounter: TEST_ENCOUNTER_ID,
        intent: 'reconcile-medications',
        fhirUser: 'Practitioner/dr-smith',
      })

      // Step 1: Authorize with launch code
      const authorizeRes = await authRoutes.handle(authRequest(
        `/auth/authorize?response_type=code&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_CLIENT_REDIRECT)}&scope=openid+launch+patient/*.read&state=ehr-e2e&launch=${launchCode}`
      ))
      expect(authorizeRes.status).toBe(302)
      const kcRedirect = new URL(authorizeRes.headers.get('location')!)
      const sessionKey = kcRedirect.searchParams.get('state')!

      // Verify session has pre-populated context and no picker needed
      const session = launchContextStore.get(sessionKey)!
      expect(session.patient).toBe(TEST_PATIENT_ID)
      expect(session.encounter).toBe(TEST_ENCOUNTER_ID)
      expect(session.needsPatientPicker).toBe(false)

      // Step 2: KC callback — should go straight to client (no picker)
      const callbackRes = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=ehr-e2e-code&state=${sessionKey}`
      ))
      expect(callbackRes.status).toBe(302)
      const clientRedirect = new URL(callbackRes.headers.get('location')!)
      expect(clientRedirect.origin + clientRedirect.pathname).toBe(TEST_CLIENT_REDIRECT)
      expect(clientRedirect.searchParams.get('state')).toBe('ehr-e2e')

      // Step 3: Token exchange
      const mockToken = createMockAccessToken({ smart_scope: 'openid launch patient/*.read' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch patient/*.read',
      })

      const tokenRes = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'ehr-e2e-code',
          redirect_uri: TEST_CLIENT_REDIRECT,
          client_id: TEST_CLIENT_ID,
        }).toString(),
      }))
      expect(tokenRes.status).toBe(200)
      const tokenData = await tokenRes.json()
      expect(tokenData.patient).toBe(TEST_PATIENT_LOGICAL_ID)
      expect(tokenData.encounter).toBe(TEST_ENCOUNTER_LOGICAL_ID)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge Cases and Bug Detection
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge cases — bug detection', () => {
    it.serial('client state with special characters is preserved correctly', async () => {
      const specialState = 'state=with&special/chars?and#fragment'
      const [sessionKey] = createTestSession({
        clientState: specialState,
        needsPatientPicker: false,
        patient: TEST_PATIENT_ID,
      })

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=special-code&state=${sessionKey}`
      ))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.searchParams.get('state')).toBe(specialState)
    })

    it.serial('empty client state is handled gracefully', async () => {
      const [sessionKey] = createTestSession({
        clientState: '',
        needsPatientPicker: false,
        patient: TEST_PATIENT_ID,
      })

      const res = await authRoutes.handle(authRequest(
        `/auth/smart-callback?code=empty-state-code&state=${sessionKey}`
      ))

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      // Empty state should not appear in the redirect
      expect(location.searchParams.has('state')).toBe(false)
    })

    it.serial('token request without client_id does not crash (no session match)', async () => {
      createTestSession({ patient: TEST_PATIENT_ID, needsPatientPicker: false })

      const mockToken = createMockAccessToken()
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'no-client-id',
        redirect_uri: TEST_CLIENT_REDIRECT,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      // Should not crash — just no enrichment
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.patient).toBeUndefined()
    })

    it.serial('token request without redirect_uri does not crash', async () => {
      createTestSession({ patient: TEST_PATIENT_ID, needsPatientPicker: false })

      const mockToken = createMockAccessToken()
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'no-redirect-uri',
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      // Should not crash — just no enrichment
      expect(res.status).toBe(200)
    })

    it.serial('scope with launch (EHR) emits patient from session', async () => {
      // "launch" scope (without /patient) should also gate patient emission
      createTestSession({
        patient: TEST_PATIENT_ID,
        needsPatientPicker: false,
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'launch-scope-test',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      // "launch" scope should also allow patient emission
      expect(data.patient).toBe(TEST_PATIENT_LOGICAL_ID)
    })

    it.serial('handles launch/encounter scope for EHR launch context', async () => {
      createTestSession({
        encounter: TEST_ENCOUNTER_ID,
        needsPatientPicker: false,
        scope: 'openid launch/encounter',
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/encounter' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/encounter',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'encounter-only',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.encounter).toBe(TEST_ENCOUNTER_LOGICAL_ID)
    })

    it.serial('intent, tenant, smart_style_url are passed through without scope gating', async () => {
      createTestSession({
        patient: TEST_PATIENT_ID,
        intent: 'order-review',
        tenant: 'hospital-a',
        smartStyleUrl: 'https://ehr.example/style.json',
        needsPatientPicker: false,
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'extras-test',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.intent).toBe('order-review')
      expect(data.tenant).toBe('hospital-a')
      expect(data.smart_style_url).toBe('https://ehr.example/style.json')
    })

    it.serial('fhirUser-to-patient derivation when session has no patient but token has Patient/ fhirUser', async () => {
      // Patient portal scenario: fhirUser is Patient/123, no explicit patient in session
      // Should derive patient from fhirUser
      createTestSession({
        needsPatientPicker: false,
        // No patient set in session
      })

      const mockToken = createMockAccessToken({
        fhirUser: 'Patient/portal-user-456',
        smart_scope: 'openid launch/patient',
      })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'fhir-user-derive',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      // Patient should be derived from fhirUser Patient/ reference
      expect(data.patient).toBe('portal-user-456')
    })

    it.serial('fhirUser derivation does NOT trigger for Practitioner/ references', async () => {
      createTestSession({
        needsPatientPicker: false,
        // No patient set
      })

      const mockToken = createMockAccessToken({
        fhirUser: 'Practitioner/dr-smith',
        smart_scope: 'openid launch/patient',
      })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'no-derive-practitioner',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      // Should NOT derive patient from Practitioner reference
      expect(data.patient).toBeUndefined()
    })

    it.serial('KC token error response is forwarded with correct status code', async () => {
      mockFetchFn = (async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        if (urlStr.includes(`/realms/${TEST_REALM}`) && !urlStr.includes('/protocol/')) {
          return new Response('{}', { status: 200 })
        }
        if (urlStr.includes('/protocol/openid-connect/token')) {
          return new Response(JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Code not valid',
          }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('Not Found', { status: 404 })
      }) as typeof fetch

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'invalid-code',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('invalid_grant')
      expect(data.error_description).toBe('Code not valid')
    })

    it.serial('duplicate sessions (same clientId + redirectUri) — first match wins, second survives', async () => {
      // Bug vector: find() returns first match. If two sessions exist for
      // the same client+redirect, only first is consumed.
      const [key1] = createTestSession({
        patient: 'Patient/first',
        needsPatientPicker: false,
      })
      const [key2] = createTestSession({
        patient: 'Patient/second',
        needsPatientPicker: false,
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'dup-test',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      // First request consumes one session
      const res1 = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))
      const data1 = await res1.json()
      // Should get one of the patients
      expect(data1.patient).toBeDefined()
      const firstPatient = data1.patient

      // Second request should get the OTHER session
      const res2 = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))
      const data2 = await res2.json()
      expect(data2.patient).toBeDefined()
      // Must be the OTHER patient (proving sessions are consumed independently)
      expect(data2.patient).not.toBe(firstPatient)

      // Both sessions should now be consumed
      expect(launchContextStore.get(key1)).toBeNull()
      expect(launchContextStore.get(key2)).toBeNull()
    })

    it.serial('needPatientBanner boolean false is correctly included in token response', async () => {
      createTestSession({
        patient: TEST_PATIENT_ID,
        needPatientBanner: false, // explicitly false
        needsPatientPicker: false,
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'banner-test',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      // `false` must be explicitly included, not omitted
      expect(data.need_patient_banner).toBe(false)
    })

    it.serial('fhirContext JSON is parsed and included in token response', async () => {
      const fhirContext = JSON.stringify([{ reference: 'ImagingStudy/img-001' }])
      createTestSession({
        patient: TEST_PATIENT_ID,
        fhirContext,
        needsPatientPicker: false,
      })

      const mockToken = createMockAccessToken({ smart_scope: 'openid launch/patient' })
      mockFetchFn = createKcReachableFetch({
        access_token: mockToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid launch/patient',
      })

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'fhir-context-test',
        redirect_uri: TEST_CLIENT_REDIRECT,
        client_id: TEST_CLIENT_ID,
      })

      const res = await authRoutes.handle(authRequest('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      }))

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.fhirContext).toEqual([{ reference: 'ImagingStudy/img-001' }])
    })
  })
})
