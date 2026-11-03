// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { mockKcAdminFactory } from './helpers/keycloak-admin'
import { TEST_BASE_URL, formRequest, omitTestEnv, testRequest, useTestEnv } from './helpers/test-env'
import { jsonResponse, readJson, stringField, stubKeycloakEndpoint } from './helpers/fake-fetch'
import { jwtClaims, mockAuthRouteModules, signRealmToken } from './helpers/oauth-routes'

const CLIENT_ID = 'chart-app'
const REDIRECT = 'https://chart.example.com/callback'
const FULL_SCOPE = 'openid fhirUser launch/patient launch/encounter patient/*.rs offline_access'

mockLoggerModule()
mockKcAdminFactory()
mockAuthRouteModules({ validateToken: async (token) => jwtClaims(token) })

mock.module('@/lib/smart-client-config-cache', () => ({
  getSmartClientConfig: async () => ({ patientFacing: undefined, redirectUris: [REDIRECT] }),
  getRegisteredRedirectUris: async () => [REDIRECT],
  invalidateClientConfig: () => {},
  clearClientConfigCache: () => {},
}))

let kcScope = FULL_SCOPE
let accessClaims: Record<string, unknown> = {}
let issuedCount = 0
let refreshHasJti = true
let refreshSid = 'session-1'

function issue(index: number): Record<string, unknown> {
  return {
    access_token: signRealmToken({ sub: 'user-1', azp: CLIENT_ID, jti: `at-${index}`, scope: kcScope, ...accessClaims }),
    refresh_token: signRealmToken({ sub: 'user-1', azp: CLIENT_ID, typ: 'Refresh', sid: refreshSid, ...(refreshHasJti && { jti: `rt-${index}` }) }),
    token_type: 'Bearer',
    expires_in: 300,
    scope: kcScope,
  }
}

const keycloak = stubKeycloakEndpoint('token', () => {
  issuedCount += 1
  return jsonResponse(issue(issuedCount))
})

import { authRoutes } from '../src/routes/auth'
import { launchContextStore } from '../src/lib/launch-context-store'
import { tokenContextStore } from '../src/lib/token-context-store'
import { fhirServerStore } from '../src/lib/fhir-server-store'
import { config } from '../src/config'
import { hashAuthCode, type LaunchSession } from '@proxy-smart/auth'

const ALPHA = `${TEST_BASE_URL}/${config.name}/alpha/R4`
const BETA = `${TEST_BASE_URL}/${config.name}/beta/R4`

const post = (path: string, form: Record<string, string>) => authRoutes.handle(formRequest(`/auth/${path}`, form))

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

async function redeemOk(code: string): Promise<Record<string, unknown>> {
  const res = await redeem(code)
  expect(res.status).toBe(200)
  return readJson(res)
}

const refresh = (refreshToken: string, scope?: string) =>
  post('token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, ...(scope && { scope }) })

describe('token endpoint conformance', () => {
  useTestEnv({ ...omitTestEnv('FHIR_BASE_URL', 'PROXY_NAME'), FHIR_SERVER_BASE: 'http://upstream-alpha.test/fhir' })

  beforeEach(async () => {
    keycloak.reset()
    kcScope = FULL_SCOPE
    accessClaims = { fhirUser: 'Practitioner/dr-1' }
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
      expect((await readJson(res)).error).toBe('invalid_grant')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(keycloak.calls).toHaveLength(0)
    })

    it('refuses a redirect_uri other than the one the authorization request carried', async () => {
      launchSession('code-other')
      const res = await redeem('code-other', 'https://evil.example.com/callback')

      expect(res.status).toBe(400)
      expect((await readJson(res)).error).toBe('invalid_grant')
      expect(keycloak.calls).toHaveLength(0)
    })

    it('redeems the code with the proxy callback once the app redirect_uri matched', async () => {
      launchSession('code-ok')
      const res = await redeem('code-ok')

      expect(res.status).toBe(200)
      expect(keycloak.last().params.get('redirect_uri')).toBe(`${TEST_BASE_URL}/auth/smart-callback`)
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
      const first = await redeemOk('code-r1')
      expect(first.patient).toBe('p-1')

      const second = await refresh(stringField(first, 'refresh_token'))
      const body = await readJson(second)

      expect(second.status).toBe(200)
      expect(body.patient).toBe('p-1')
      expect(body.encounter).toBe('e-1')
      expect(body.fhirContext).toEqual([{ reference: 'DiagnosticReport/dr-9' }])
      expect(body.intent).toBe('review')
      const accessJti = stringField(jwtClaims(stringField(body, 'access_token')), 'jti')
      expect((await tokenContextStore.get(accessJti, CLIENT_ID))?.patient).toBe('p-1')

      const third = await readJson(await refresh(stringField(body, 'refresh_token')))
      expect(third.patient).toBe('p-1')
    })

    it('drops context the narrowed refresh scope no longer allows', async () => {
      launchSession('code-r2', { patient: 'Patient/p-2', encounter: 'Encounter/e-2' })
      const first = await redeemOk('code-r2')
      expect(first.encounter).toBe('e-2')

      kcScope = 'openid launch/patient'
      const body = await readJson(await refresh(stringField(first, 'refresh_token'), kcScope))

      expect(body.patient).toBe('p-2')
      expect(body.encounter).toBeUndefined()
    })

    it('follows a refresh token without jti by its session and client', async () => {
      refreshHasJti = false
      refreshSid = 'session-no-jti'
      launchSession('code-r5', { patient: 'Patient/p-5' })
      const first = await redeemOk('code-r5')

      const body = await readJson(await refresh(stringField(first, 'refresh_token')))

      expect(body.patient).toBe('p-5')
    })

    it('carries nothing for a refresh token it never saw', async () => {
      const res = await refresh(signRealmToken({ sub: 'user-1', azp: CLIENT_ID, jti: 'rt-unknown', typ: 'Refresh' }))
      const body = await readJson(res)

      expect(res.status).toBe(200)
      expect(body.access_token).toBeString()
      expect(body.patient).toBeUndefined()
    })

    it('carries nothing when Keycloak refuses the refresh', async () => {
      launchSession('code-r3', { patient: 'Patient/p-3' })
      const first = await redeemOk('code-r3')

      keycloak.reset(() => jsonResponse({ error: 'invalid_grant', error_description: 'Token is not active' }, 400))
      const res = await refresh(stringField(first, 'refresh_token'))
      const body = await readJson(res)

      expect(res.status).toBe(400)
      expect(body.error).toBe('invalid_grant')
      expect(body.patient).toBeUndefined()
    })

    it("does not hand one client the context stored for another client's refresh token", async () => {
      launchSession('code-r4', { patient: 'Patient/p-4' })
      const first = await redeemOk('code-r4')

      const res = await post('token', { grant_type: 'refresh_token', refresh_token: stringField(first, 'refresh_token'), client_id: 'other-app' })
      const body = await readJson(res)

      expect(res.status).toBe(200)
      expect(body.patient).toBeUndefined()
    })
  })

  describe('fhirUser', () => {
    it('is absolute against the FHIR server the authorization was for', async () => {
      launchSession('code-f1', { aud: BETA })
      const body = await redeemOk('code-f1')

      expect(body.fhirUser).toBe(`${BETA}/Practitioner/dr-1`)
    })

    it('is only returned when openid and fhirUser were both granted', async () => {
      kcScope = 'openid profile launch/patient'
      launchSession('code-f2')
      const body = await redeemOk('code-f2')

      expect(body.patient).toBe('p-0')
      expect(body.fhirUser).toBeUndefined()
    })
  })

  describe('granted scope', () => {
    it('is what Keycloak granted, never a wider smart_scope claim', async () => {
      kcScope = 'openid launch/patient patient/Observation.rs'
      accessClaims = { smart_scope: 'patient/*.cruds system/*.*' }
      launchSession('code-s1')
      const body = await redeemOk('code-s1')

      expect(body.scope).toBe(kcScope)
    })
  })

  describe('OAuth error bodies', () => {
    it('answers a malformed token request with invalid_request and no-store', async () => {
      const res = await post('token', { code: 'x' })

      expect(res.status).toBe(400)
      expect((await readJson(res)).error).toBe('invalid_request')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('answers an unexpected failure with server_error and no-store', async () => {
      keycloak.reset(() => {
        throw new Error('connect ECONNREFUSED')
      })
      const res = await post('token', { grant_type: 'client_credentials', client_id: 'svc', client_secret: 's' })

      expect(res.status).toBe(500)
      expect((await readJson(res)).error).toBe('server_error')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('answers a malformed registration with invalid_client_metadata', async () => {
      const res = await authRoutes.handle(testRequest('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: 'not-an-array' }),
      }))

      expect(res.status).toBe(400)
      expect((await readJson(res)).error).toBe('invalid_client_metadata')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('leaves non-OAuth routes to their own error handling', async () => {
      const res = await authRoutes.handle(testRequest('/auth/patient-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }))

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.headers.get('cache-control')).not.toBe('no-store')
    })
  })
})
