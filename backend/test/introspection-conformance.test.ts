// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { fakeKcAdmin, mockKcAdminFactory } from './helpers/keycloak-admin'
import { basicAuth, formRequest, omitTestEnv, useTestEnv } from './helpers/test-env'
import { jsonResponse, readJson, stubKeycloakEndpoint } from './helpers/fake-fetch'
import { jwtClaims, mockAuthRouteModules, signRealmToken } from './helpers/oauth-routes'

const CLIENT_ID = 'chart-app'
const REDIRECT = 'https://chart.example.com/callback'
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const PATIENT_SCOPE = 'openid launch patient/*.rs'

mockLoggerModule()
mockKcAdminFactory(async () => fakeKcAdmin().admin)
mockAuthRouteModules({ validateToken: async (token) => jwtClaims(token) })

class ClientAssertionError extends Error {
  constructor(readonly oauthError: string, readonly description: string, readonly httpStatus: number = 400) {
    super(description)
  }
}

mock.module('@/routes/auth/backend-services', () => ({
  JWT_BEARER_TYPE: JWT_BEARER,
  ClientAssertionError,
  clearJtiCache: () => {},
  hasClientAssertion: (body: Record<string, string | undefined>) => body.client_assertion_type === JWT_BEARER && !!body.client_assertion,
  validateClientAssertion: async () => ({ clientId: 'rs-jwt', internalId: 'x' }),
  translateClientAssertion: async (assertion: string) => {
    if (assertion !== 'client-signed') throw new ClientAssertionError('invalid_client', 'JWT signature verification failed', 401)
    return { clientId: 'rs-jwt', proxyAssertion: 'proxy-signed' }
  },
}))

let issuedJti = 'at-1'
let issuedScope = PATIENT_SCOPE

const keycloak = stubKeycloakEndpoint('token', ({ url }) => jsonResponse(url.endsWith('/introspect')
  ? { active: true, client_id: CLIENT_ID, scope: 'openid', exp: Math.floor(Date.now() / 1000) + 300 }
  : { access_token: signRealmToken({ sub: 'u1', azp: CLIENT_ID, jti: issuedJti, scope: issuedScope }), token_type: 'Bearer', expires_in: 300, scope: issuedScope }))

import { authRoutes } from '../src/routes/auth'
import { config } from '../src/config'
import { launchContextStore } from '../src/lib/launch-context-store'
import { hashAuthCode } from '@proxy-smart/auth'

const introspect = (form: Record<string, string>, authorization?: string) =>
  authRoutes.handle(formRequest('/auth/introspect', form, authorization))

describe('token introspection conformance', () => {
  useTestEnv(omitTestEnv('FHIR_BASE_URL', 'PROXY_NAME'))

  beforeEach(() => {
    keycloak.reset()
    issuedScope = PATIENT_SCOPE
  })

  afterEach(() => {
    launchContextStore.dispose()
  })

  describe('a caller authenticating with a SMART bearer token', () => {
    it('is answered when the token carries the introspection scope, using the proxy introspection client', async () => {
      const caller = signRealmToken({ sub: 'svc', azp: 'monitor', scope: `system/*.rs ${config.smart.introspectionScope}` })
      const token = signRealmToken({ sub: 'u1', jti: 'x-1' })
      const res = await introspect({ token }, `Bearer ${caller}`)

      expect(res.status).toBe(200)
      expect((await readJson(res)).active).toBe(true)
      expect(keycloak.last().authorization).toBe(basicAuth('admin-service', 'admin-secret'))
      expect(keycloak.last().params.get('token')).toBe(token)
    })

    it('is refused with insufficient_scope when the token lacks the introspection scope', async () => {
      const caller = signRealmToken({ sub: 'svc', azp: 'monitor', scope: 'system/*.rs' })
      const res = await introspect({ token: signRealmToken({ sub: 'u1' }) }, `Bearer ${caller}`)

      expect(res.status).toBe(403)
      expect((await readJson(res)).error).toBe('insufficient_scope')
      expect(res.headers.get('www-authenticate')).toContain('insufficient_scope')
      expect(keycloak.calls).toHaveLength(0)
    })

    it('is refused with invalid_token when the bearer token does not validate', async () => {
      const res = await introspect({ token: signRealmToken({ sub: 'u1' }) }, 'Bearer not-a-valid-token')

      expect(res.status).toBe(401)
      expect((await readJson(res)).error).toBe('invalid_token')
      expect(res.headers.get('www-authenticate')).toStartWith('Bearer')
      expect(keycloak.calls).toHaveLength(0)
    })
  })

  describe('a caller authenticating with private_key_jwt', () => {
    it('reaches Keycloak with the proxy-signed assertion, not its own', async () => {
      const res = await introspect({ token: signRealmToken({ sub: 'u1' }), client_assertion_type: JWT_BEARER, client_assertion: 'client-signed' })

      expect(res.status).toBe(200)
      expect(keycloak.last().params.get('client_assertion')).toBe('proxy-signed')
      expect(keycloak.last().params.get('client_id')).toBe('rs-jwt')
    })

    it('is refused without calling Keycloak when its assertion does not verify', async () => {
      const res = await introspect({ token: signRealmToken({ sub: 'u1' }), client_assertion_type: JWT_BEARER, client_assertion: 'forged' })

      expect(res.status).toBe(401)
      expect((await readJson(res)).error).toBe('invalid_client')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(keycloak.calls).toHaveLength(0)
    })
  })

  describe('the launch context it repeats', () => {
    async function issueWith(code: string, session: Record<string, unknown>, jti: string): Promise<Record<string, unknown>> {
      issuedJti = jti
      launchContextStore.set(crypto.randomUUID(), {
        clientRedirectUri: REDIRECT,
        clientState: 's',
        clientId: CLIENT_ID,
        scope: issuedScope,
        authCodeHash: hashAuthCode(code),
        createdAt: Date.now(),
        ...session,
      })
      const res = await authRoutes.handle(formRequest('/auth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: CLIENT_ID }))
      expect(res.status).toBe(200)
      return readJson(res)
    }

    const introspectJti = async (jti: string) =>
      readJson(await introspect({ token: signRealmToken({ sub: 'u1', jti }) }, basicAuth('rs-1', 'x')))

    it('includes context fields the token response carried without a patient', async () => {
      issuedScope = 'openid launch user/*.rs'
      const issued = await issueWith('code-intent', { intent: 'reconcile-medications', tenant: 't-1', needPatientBanner: false }, 'at-intent')
      expect(issued.intent).toBe('reconcile-medications')

      const data = await introspectJti('at-intent')

      expect(data.intent).toBe('reconcile-medications')
      expect(data.tenant).toBe('t-1')
      expect(data.need_patient_banner).toBe(false)
    })

    it('reports the scope the token response granted', async () => {
      const issued = await issueWith('code-scope', { patient: 'Patient/p-1' }, 'at-scope')
      expect(issued.scope).toBe(PATIENT_SCOPE)

      const data = await introspectJti('at-scope')

      expect(data.scope).toBe(PATIENT_SCOPE)
    })
  })
})
