// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { mockKcAdminFactory } from './helpers/keycloak-admin'
import { TEST_BASE_URL, basicAuth, formRequest, useTestEnv } from './helpers/test-env'
import { jsonResponse, readJson, stubKeycloakEndpoint } from './helpers/fake-fetch'
import { jwtClaims, mockAuthRouteModules, signRealmToken } from './helpers/oauth-routes'

mockLoggerModule()
mockKcAdminFactory()
mockAuthRouteModules({ validateToken: async (token) => jwtClaims(token) })

const keycloak = stubKeycloakEndpoint('token', ({ url }) => jsonResponse(url.endsWith('/introspect')
  ? { active: true, client_id: 'patient-app', scope: 'launch/patient patient/*.rs' }
  : { access_token: signRealmToken({ sub: 'svc', aud: 'account' }), token_type: 'Bearer', expires_in: 300 }))

import { authRoutes } from '../src/routes/auth'
import { tokenContextStore } from '../src/lib/token-context-store'

const post = (path: string, form: Record<string, string>, authorization?: string) =>
  authRoutes.handle(formRequest(`/auth/${path}`, form, authorization))

const introspectAs = async (claims: Record<string, unknown>) =>
  readJson(await post('introspect', { token: signRealmToken(claims) }, basicAuth('rs-1', 'x')))

describe('client authentication reaches Keycloak as the client sent it', () => {
  useTestEnv()

  beforeEach(() => {
    keycloak.reset()
  })

  it('forwards client_secret_basic on the token endpoint', async () => {
    const res = await post('token', { grant_type: 'client_credentials' }, basicAuth('backend-svc', 's3cret'))

    expect(res.status).toBe(200)
    expect(keycloak.last().authorization).toBe(basicAuth('backend-svc', 's3cret'))
  })

  it('refuses an introspection caller that does not authenticate', async () => {
    const res = await post('introspect', { token: signRealmToken({ sub: 'u1', jti: 'anon-1' }) })

    expect(res.status).toBe(401)
    expect((await readJson(res)).error).toBe('invalid_client')
    expect(res.headers.get('www-authenticate')).toStartWith('Basic')
    expect(keycloak.calls).toHaveLength(0)
  })

  it('refuses a bare client_id, which identifies but does not authenticate', async () => {
    const res = await post('introspect', { token: signRealmToken({ sub: 'u1' }), client_id: 'patient-app' })

    expect(res.status).toBe(401)
    expect(keycloak.calls).toHaveLength(0)
  })

  it('introspects as the resource server that authenticated with HTTP Basic', async () => {
    const res = await post('introspect', { token: signRealmToken({ sub: 'u1' }) }, basicAuth('rs-1', 'rs-secret'))

    expect(res.status).toBe(200)
    expect(keycloak.last().authorization).toBe(basicAuth('rs-1', 'rs-secret'))
    expect(keycloak.last().params.has('client_secret')).toBe(false)
  })

  it('introspects as the resource server that sent its credentials in the body', async () => {
    const res = await post('introspect', { token: signRealmToken({ sub: 'u1' }), client_id: 'rs-1', client_secret: 'rs-secret' })

    expect(res.status).toBe(200)
    expect(keycloak.last().authorization).toBeNull()
    expect(keycloak.last().params.get('client_id')).toBe('rs-1')
  })

  it('gives an authenticated resource server the launch context of the app the token was issued to', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300
    await tokenContextStore.set('issued-1', { patient: 'p-42', clientId: 'patient-app', exp })
    await tokenContextStore.set('issued-2', { patient: 'p-43', clientId: 'another-app', exp })

    const own = await introspectAs({ sub: 'u1', jti: 'issued-1' })
    const foreign = await introspectAs({ sub: 'u1', jti: 'issued-2' })

    expect(own.patient).toBe('p-42')
    expect(foreign.active).toBe(true)
    expect(foreign.patient).toBeUndefined()
  })

  it('returns the fhirContext the token response carried', async () => {
    const fhirContext = [{ reference: 'ImagingStudy/img-1' }, { identifier: { system: 'urn:x', value: '7' }, type: 'ServiceRequest' }]
    await tokenContextStore.set('ctx-1', { fhirContext, clientId: 'patient-app', exp: Math.floor(Date.now() / 1000) + 300 })

    const data = await introspectAs({ sub: 'u1', jti: 'ctx-1' })

    expect(data.fhirContext).toEqual(fhirContext)
  })

  it("returns the token response's absolute fhirUser rather than the raw relative claim", async () => {
    const absolute = `${TEST_BASE_URL}/fhir/hapi/R4/Practitioner/pr-1`
    await tokenContextStore.set('ctx-2', { fhirUser: absolute, clientId: 'patient-app', exp: Math.floor(Date.now() / 1000) + 300 })

    const data = await introspectAs({ sub: 'u1', jti: 'ctx-2', fhirUser: 'Practitioner/pr-1' })

    expect(data.fhirUser).toBe(absolute)
  })
})
