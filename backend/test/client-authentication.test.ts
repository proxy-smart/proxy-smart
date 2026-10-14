// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { TEST_BASE_URL, TEST_KC_BASE_URL, TEST_REALM, useTestEnv } from './helpers/test-env'
import { captureRequest, requestUrl, type CapturedRequest } from './helpers/fake-fetch'
import jwt from 'jsonwebtoken'

mockLoggerModule()

mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

mock.module('@/lib/auth', () => ({
  validateToken: async (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()),
}))

mock.module('@/lib/kc-session-resolver', () => ({
  autoResolvePatient: async () => null,
}))

const calls: CapturedRequest[] = []
const sign = (claims: Record<string, unknown>) =>
  jwt.sign({ iss: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`, ...claims }, 'k', { expiresIn: '5m' })

mock.module('cross-fetch', () => ({
  default: async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = requestUrl(url)
    if (!urlStr.includes('/protocol/openid-connect/token')) return new Response('{}', { status: 200 })
    calls.push(captureRequest(urlStr, opts))
    const body = urlStr.endsWith('/introspect')
      ? { active: true, client_id: 'patient-app', scope: 'launch/patient patient/*.rs' }
      : { access_token: sign({ sub: 'svc', aud: 'account' }), token_type: 'Bearer', expires_in: 300 }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  },
}))

import { authRoutes } from '../src/routes/auth'
import { tokenContextStore } from '../src/lib/token-context-store'

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

function post(path: string, form: Record<string, string>, authorization?: string): Promise<Response> {
  return authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(authorization && { Authorization: authorization }),
    },
    body: new URLSearchParams(form).toString(),
  }))
}

describe('client authentication reaches Keycloak as the client sent it', () => {
  useTestEnv()

  beforeEach(() => {
    calls.length = 0
  })

  it('forwards client_secret_basic on the token endpoint', async () => {
    const res = await post('token', { grant_type: 'client_credentials' }, basic('backend-svc', 's3cret'))

    expect(res.status).toBe(200)
    expect(calls[0]?.authorization).toBe(basic('backend-svc', 's3cret'))
  })

  it('refuses an introspection caller that does not authenticate', async () => {
    const res = await post('introspect', { token: sign({ sub: 'u1', jti: 'anon-1' }) })

    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('invalid_client')
    expect(res.headers.get('www-authenticate')).toStartWith('Basic')
    expect(calls).toHaveLength(0)
  })

  it('refuses a bare client_id, which identifies but does not authenticate', async () => {
    const res = await post('introspect', { token: sign({ sub: 'u1' }), client_id: 'patient-app' })

    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('introspects as the resource server that authenticated with HTTP Basic', async () => {
    const res = await post('introspect', { token: sign({ sub: 'u1' }) }, basic('rs-1', 'rs-secret'))

    expect(res.status).toBe(200)
    expect(calls[0]?.authorization).toBe(basic('rs-1', 'rs-secret'))
    expect(calls[0]?.params.has('client_secret')).toBe(false)
  })

  it('introspects as the resource server that sent its credentials in the body', async () => {
    const res = await post('introspect', { token: sign({ sub: 'u1' }), client_id: 'rs-1', client_secret: 'rs-secret' })

    expect(res.status).toBe(200)
    expect(calls[0]?.authorization).toBeNull()
    expect(calls[0]?.params.get('client_id')).toBe('rs-1')
  })

  it('gives an authenticated resource server the launch context of the app the token was issued to', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300
    await tokenContextStore.set('issued-1', { patient: 'p-42', clientId: 'patient-app', exp })
    await tokenContextStore.set('issued-2', { patient: 'p-43', clientId: 'another-app', exp })

    const own = await (await post('introspect', { token: sign({ sub: 'u1', jti: 'issued-1' }) }, basic('rs-1', 'x'))).json()
    const foreign = await (await post('introspect', { token: sign({ sub: 'u1', jti: 'issued-2' }) }, basic('rs-1', 'x'))).json()

    expect(own.patient).toBe('p-42')
    expect(foreign.patient).toBeUndefined()
  })

  it('returns the fhirContext the token response carried', async () => {
    const fhirContext = [{ reference: 'ImagingStudy/img-1' }, { identifier: { system: 'urn:x', value: '7' }, type: 'ServiceRequest' }]
    await tokenContextStore.set('ctx-1', { fhirContext, clientId: 'patient-app', exp: Math.floor(Date.now() / 1000) + 300 })

    const data = await (await post('introspect', { token: sign({ sub: 'u1', jti: 'ctx-1' }) }, basic('rs-1', 'x'))).json()

    expect(data.fhirContext).toEqual(fhirContext)
  })

  it("returns the token response's absolute fhirUser rather than the raw relative claim", async () => {
    const absolute = `${TEST_BASE_URL}/fhir/hapi/R4/Practitioner/pr-1`
    await tokenContextStore.set('ctx-2', { fhirUser: absolute, clientId: 'patient-app', exp: Math.floor(Date.now() / 1000) + 300 })

    const data = await (await post('introspect', { token: sign({ sub: 'u1', jti: 'ctx-2', fhirUser: 'Practitioner/pr-1' }) }, basic('rs-1', 'x'))).json()

    expect(data.fhirUser).toBe(absolute)
  })
})
