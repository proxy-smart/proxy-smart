// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { TEST_BASE_URL, TEST_KC_BASE_URL, TEST_REALM, omitTestEnv, useTestEnv } from './helpers/test-env'
import { captureRequest, requestUrl, type CapturedRequest } from './helpers/fake-fetch'
import jwt from 'jsonwebtoken'

const CLIENT_ID = 'chart-app'
const REDIRECT = 'https://chart.example.com/callback'
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

mockLoggerModule()

mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

mock.module('@/lib/auth', () => ({
  validateToken: async (token: string) => {
    if (token === 'not-a-valid-token') throw new Error('invalid token')
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  },
}))

mock.module('@/lib/kc-session-resolver', () => ({
  autoResolvePatient: async () => null,
}))

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

const calls: CapturedRequest[] = []
const sign = (claims: Record<string, unknown>) =>
  jwt.sign({ iss: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`, ...claims }, 'k', { expiresIn: '5m' })

let issuedJti = 'at-1'
const PATIENT_SCOPE = 'openid launch patient/*.rs'
let issuedScope = PATIENT_SCOPE
let introspectedScope = 'openid'

mock.module('cross-fetch', () => ({
  default: async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = requestUrl(url)
    if (!urlStr.includes('/protocol/openid-connect/token')) return new Response('{}', { status: 200 })
    calls.push(captureRequest(urlStr, opts))
    const body = urlStr.endsWith('/introspect')
      ? { active: true, client_id: CLIENT_ID, scope: introspectedScope, exp: Math.floor(Date.now() / 1000) + 300 }
      : { access_token: sign({ sub: 'u1', azp: CLIENT_ID, jti: issuedJti, scope: issuedScope }), token_type: 'Bearer', expires_in: 300, scope: issuedScope }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  },
}))

import { authRoutes } from '../src/routes/auth'
import { config } from '../src/config'
import { launchContextStore } from '../src/lib/launch-context-store'
import { hashAuthCode } from '@proxy-smart/auth'

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

function introspect(form: Record<string, string>, authorization?: string): Promise<Response> {
  return authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/introspect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(authorization && { Authorization: authorization }),
    },
    body: new URLSearchParams(form).toString(),
  }))
}

describe('token introspection conformance', () => {
  useTestEnv(omitTestEnv('FHIR_BASE_URL', 'PROXY_NAME'))

  beforeEach(() => {
    calls.length = 0
    introspectedScope = 'openid'
  })

  afterEach(() => {
    launchContextStore.dispose()
  })

  describe('a caller authenticating with a SMART bearer token', () => {
    it('is answered when the token carries the introspection scope, using the proxy introspection client', async () => {
      const caller = sign({ sub: 'svc', azp: 'monitor', scope: `system/*.rs ${config.smart.introspectionScope}` })
      const res = await introspect({ token: sign({ sub: 'u1', jti: 'x-1' }) }, `Bearer ${caller}`)

      expect(res.status).toBe(200)
      expect((await res.json()).active).toBe(true)
      expect(calls[0]?.authorization).toBe(basic('admin-service', 'admin-secret'))
      expect(calls[0]?.params.get('token')).toBeTruthy()
    })

    it('is refused with insufficient_scope when the token lacks the introspection scope', async () => {
      const caller = sign({ sub: 'svc', azp: 'monitor', scope: 'system/*.rs' })
      const res = await introspect({ token: sign({ sub: 'u1' }) }, `Bearer ${caller}`)

      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('insufficient_scope')
      expect(res.headers.get('www-authenticate')).toContain('insufficient_scope')
      expect(calls).toHaveLength(0)
    })

    it('is refused with invalid_token when the bearer token does not validate', async () => {
      const res = await introspect({ token: sign({ sub: 'u1' }) }, 'Bearer not-a-valid-token')

      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('invalid_token')
      expect(res.headers.get('www-authenticate')).toStartWith('Bearer')
      expect(calls).toHaveLength(0)
    })
  })

  describe('a caller authenticating with private_key_jwt', () => {
    it('reaches Keycloak with the proxy-signed assertion, not its own', async () => {
      const res = await introspect({ token: sign({ sub: 'u1' }), client_assertion_type: JWT_BEARER, client_assertion: 'client-signed' })

      expect(res.status).toBe(200)
      expect(calls[0]?.params.get('client_assertion')).toBe('proxy-signed')
      expect(calls[0]?.params.get('client_id')).toBe('rs-jwt')
    })

    it('is refused without calling Keycloak when its assertion does not verify', async () => {
      const res = await introspect({ token: sign({ sub: 'u1' }), client_assertion_type: JWT_BEARER, client_assertion: 'forged' })

      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('invalid_client')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(calls).toHaveLength(0)
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
      const res = await authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: CLIENT_ID }).toString(),
      }))
      return res.json()
    }

    it('includes context fields the token response carried without a patient', async () => {
      issuedScope = 'openid launch user/*.rs'
      const issued = await issueWith('code-intent', { intent: 'reconcile-medications', tenant: 't-1', needPatientBanner: false }, 'at-intent')
      expect(issued.intent).toBe('reconcile-medications')

      const data = await (await introspect({ token: sign({ sub: 'u1', jti: 'at-intent' }) }, basic('rs-1', 'x'))).json()

      expect(data.intent).toBe('reconcile-medications')
      expect(data.tenant).toBe('t-1')
      expect(data.need_patient_banner).toBe(false)
      issuedScope = PATIENT_SCOPE
    })

    it('reports the scope the token response granted', async () => {
      const issued = await issueWith('code-scope', { patient: 'Patient/p-1' }, 'at-scope')
      introspectedScope = 'openid'

      const data = await (await introspect({ token: sign({ sub: 'u1', jti: 'at-scope' }) }, basic('rs-1', 'x'))).json()

      expect(data.scope).toBe(issued.scope)
    })
  })
})
