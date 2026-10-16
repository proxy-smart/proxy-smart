// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { mockKcAdminFactory } from './helpers/keycloak-admin'
import { TEST_BASE_URL, TEST_KC_BASE_URL, TEST_REALM, omitTestEnv, useTestEnv } from './helpers/test-env'
import { requestUrl, fakeFetch } from './helpers/fake-fetch'
import jwt from 'jsonwebtoken'

const CLIENT_ID = 'chart-app'
const REDIRECT = 'https://chart.example.com/callback'

mockLoggerModule()
mockKcAdminFactory()

mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

mock.module('@/lib/auth', () => ({
  validateToken: async (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()),
}))

mock.module('@/lib/kc-session-resolver', () => ({
  autoResolvePatient: async () => null,
}))

mock.module('@/lib/smart-client-config-cache', () => ({
  getSmartClientConfig: async () => ({ patientFacing: undefined, redirectUris: [REDIRECT] }),
  getRegisteredRedirectUris: async () => [REDIRECT],
  invalidateClientConfig: () => {},
  clearClientConfigCache: () => {},
}))

const sign = (claims: Record<string, unknown>) =>
  jwt.sign({ iss: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`, ...claims }, 'k', { expiresIn: '5m' })

interface KeycloakCall { params: URLSearchParams }
const kcCalls: KeycloakCall[] = []
let kcScope = 'openid fhirUser launch/patient launch/encounter patient/*.rs offline_access'
let accessClaims: Record<string, unknown> = {}
let refreshCounter = 0
let kcFailure: { status: number; body: Record<string, unknown> } | null = null
let kcThrows = false
let refreshHasJti = true
let refreshSid = 'session-1'

function issue(index: number): Record<string, unknown> {
  return {
    access_token: sign({ sub: 'user-1', azp: CLIENT_ID, jti: `at-${index}`, scope: kcScope, ...accessClaims }),
    refresh_token: sign({ sub: 'user-1', azp: CLIENT_ID, typ: 'Refresh', sid: refreshSid, ...(refreshHasJti && { jti: `rt-${index}` }) }),
    token_type: 'Bearer',
    expires_in: 300,
    scope: kcScope,
  }
}

globalThis.fetch = fakeFetch(async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = requestUrl(url)
    if (!urlStr.includes('/protocol/openid-connect/token')) return new Response('Not Found', { status: 404 })
    if (kcThrows) throw new Error('connect ECONNREFUSED')
    const params = new URLSearchParams(opts?.body?.toString() ?? '')
    kcCalls.push({ params })
    if (kcFailure) return new Response(JSON.stringify(kcFailure.body), { status: kcFailure.status, headers: { 'content-type': 'application/json' } })
    refreshCounter += 1
    return new Response(JSON.stringify(issue(refreshCounter)), { status: 200, headers: { 'content-type': 'application/json' } })
  })

import { authRoutes } from '../src/routes/auth'
import { launchContextStore } from '../src/lib/launch-context-store'
import { tokenContextStore } from '../src/lib/token-context-store'
import { fhirServerStore } from '../src/lib/fhir-server-store'
import { config } from '../src/config'
import { hashAuthCode, type LaunchSession } from '@proxy-smart/auth'

const ALPHA = `${TEST_BASE_URL}/${config.name}/alpha/R4`
const BETA = `${TEST_BASE_URL}/${config.name}/beta/R4`

function post(path: string, form: Record<string, string>): Promise<Response> {
  return authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  }))
}

function launchSession(code: string, overrides: Partial<LaunchSession> = {}): void {
  launchContextStore.set(crypto.randomUUID(), {
    clientRedirectUri: REDIRECT,
    clientState: 's',
    clientId: CLIENT_ID,
    scope: kcScope,
    patient: 'Patient/p-0',
    aud: ALPHA,
    authCodeHash: hashAuthCode(code),
    createdAt: Date.now(),
    ...overrides,
  })
}

const redeem = (code: string, redirectUri = REDIRECT) =>
  post('token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CLIENT_ID })

const refresh = (refreshToken: string, scope?: string) =>
  post('token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, ...(scope && { scope }) })

describe('token endpoint conformance', () => {
  useTestEnv({ ...omitTestEnv('FHIR_BASE_URL', 'PROXY_NAME'), FHIR_SERVER_BASE: 'http://upstream-alpha.test/fhir' })

  beforeEach(async () => {
    kcCalls.length = 0
    kcScope = 'openid fhirUser launch/patient launch/encounter patient/*.rs offline_access'
    accessClaims = { fhirUser: 'Practitioner/dr-1' }
    kcFailure = null
    kcThrows = false
    refreshHasJti = true
    refreshSid = 'session-1'
    await fhirServerStore.initializeServers()
    for (const server of fhirServerStore.getAllServers()) fhirServerStore.removeServer(server.identifier)
    for (const identifier of ['alpha', 'beta']) {
      fhirServerStore.addServer(identifier, {
        name: identifier,
        url: `http://upstream-${identifier}.test/fhir`,
        identifier,
        metadata: { fhirVersion: 'R4', supported: true },
        lastUpdated: Date.now(),
      })
    }
  })

  afterEach(() => {
    launchContextStore.dispose()
  })

  describe('redirect_uri on an intercepted code', () => {
    it('refuses the proxy callback as redirect_uri without asking Keycloak', async () => {
      launchSession('code-cb', { patient: 'Patient/p-1' })
      const res = await redeem('code-cb', `${TEST_BASE_URL}/auth/smart-callback`)

      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_grant')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(kcCalls).toHaveLength(0)
    })

    it('refuses a redirect_uri other than the one the authorization request carried', async () => {
      launchSession('code-other')
      const res = await redeem('code-other', 'https://evil.example.com/callback')

      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_grant')
      expect(kcCalls).toHaveLength(0)
    })

    it('redeems the code with the proxy callback once the app redirect_uri matched', async () => {
      launchSession('code-ok')
      const res = await redeem('code-ok')

      expect(res.status).toBe(200)
      expect(kcCalls[0]?.params.get('redirect_uri')).toBe(`${TEST_BASE_URL}/auth/smart-callback`)
    })
  })

  describe('launch context across a refresh', () => {
    it('returns the launch context again on refresh and binds it to the new tokens', async () => {
      launchSession('code-r1', {
        patient: 'Patient/p-1',
        encounter: 'Encounter/e-1',
        fhirContext: JSON.stringify([{ reference: 'DiagnosticReport/dr-9' }]),
        intent: 'review',
      })
      const first = await (await redeem('code-r1')).json()
      expect(first.patient).toBe('p-1')

      const second = await refresh(first.refresh_token)
      const body = await second.json()

      expect(second.status).toBe(200)
      expect(body.patient).toBe('p-1')
      expect(body.encounter).toBe('e-1')
      expect(body.fhirContext).toEqual([{ reference: 'DiagnosticReport/dr-9' }])
      expect(body.intent).toBe('review')
      const accessJti = String(jwt.decode(body.access_token, { json: true })?.jti)
      expect((await tokenContextStore.get(accessJti, CLIENT_ID))?.patient).toBe('p-1')

      const third = await (await refresh(body.refresh_token)).json()
      expect(third.patient).toBe('p-1')
    })

    it('drops context the narrowed refresh scope no longer allows', async () => {
      launchSession('code-r2', { patient: 'Patient/p-2', encounter: 'Encounter/e-2' })
      const first = await (await redeem('code-r2')).json()

      kcScope = 'openid launch/patient'
      const body = await (await refresh(first.refresh_token, kcScope)).json()

      expect(body.patient).toBe('p-2')
      expect(body.encounter).toBeUndefined()
    })

    it('follows a refresh token without jti by its session and client', async () => {
      refreshHasJti = false
      refreshSid = 'session-no-jti'
      launchSession('code-r5', { patient: 'Patient/p-5' })
      const first = await (await redeem('code-r5')).json()

      const body = await (await refresh(first.refresh_token)).json()

      expect(body.patient).toBe('p-5')
    })

    it('carries nothing for a refresh token it never saw', async () => {
      const body = await (await refresh(sign({ sub: 'user-1', azp: CLIENT_ID, jti: 'rt-unknown', typ: 'Refresh' }))).json()

      expect(body.patient).toBeUndefined()
    })

    it('carries nothing when Keycloak refuses the refresh', async () => {
      launchSession('code-r3', { patient: 'Patient/p-3' })
      const first = await (await redeem('code-r3')).json()

      kcFailure = { status: 400, body: { error: 'invalid_grant', error_description: 'Token is not active' } }
      const res = await refresh(first.refresh_token)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toBe('invalid_grant')
      expect(body.patient).toBeUndefined()
    })

    it('does not hand one client the context stored for another client\'s refresh token', async () => {
      launchSession('code-r4', { patient: 'Patient/p-4' })
      const first = await (await redeem('code-r4')).json()

      const res = await post('token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: 'other-app' })

      expect((await res.json()).patient).toBeUndefined()
    })
  })

  describe('fhirUser', () => {
    it('is absolute against the FHIR server the authorization was for', async () => {
      launchSession('code-f1', { aud: BETA })
      const body = await (await redeem('code-f1')).json()

      expect(body.fhirUser).toBe(`${BETA}/Practitioner/dr-1`)
    })

    it('is only returned when openid and fhirUser were both granted', async () => {
      kcScope = 'openid profile launch/patient'
      launchSession('code-f2')
      const body = await (await redeem('code-f2')).json()

      expect(body.fhirUser).toBeUndefined()
    })
  })

  describe('granted scope', () => {
    it('is what Keycloak granted, never a wider smart_scope claim', async () => {
      kcScope = 'openid launch/patient patient/Observation.rs'
      accessClaims = { smart_scope: 'patient/*.cruds system/*.*' }
      launchSession('code-s1')
      const body = await (await redeem('code-s1')).json()

      expect(body.scope).toBe(kcScope)
    })
  })

  describe('OAuth error bodies', () => {
    it('answers a malformed token request with invalid_request and no-store', async () => {
      const res = await post('token', { code: 'x' })

      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_request')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('answers an unexpected failure with server_error and no-store', async () => {
      kcThrows = true
      const res = await post('token', { grant_type: 'client_credentials', client_id: 'svc', client_secret: 's' })

      expect(res.status).toBe(500)
      expect((await res.json()).error).toBe('server_error')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('answers a malformed registration with invalid_client_metadata', async () => {
      const res = await authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: 'not-an-array' }),
      }))

      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_client_metadata')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('leaves non-OAuth routes to their own error handling', async () => {
      const res = await authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/patient-select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }))

      expect(res.headers.get('cache-control')).not.toBe('no-store')
    })
  })
})
