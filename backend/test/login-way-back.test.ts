// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * When a sign-in fails at the identity provider, Keycloak may never have rendered its login page,
 * so the theme never learned the client. /auth/authorize remembers it in a cookie for /auth/return,
 * and the error page reports what it showed to /auth/login-error.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mockLoggerModule, noopLogger } from './helpers/mock-logger'
import { TEST_BASE_URL, BASE_TEST_ENV, testRequest, useTestEnv } from './helpers/test-env'
import { keycloakFetch } from './helpers/fake-fetch'
import { mockAuthRouteModules } from './helpers/oauth-routes'

const CLIENT_ID = 'smart-app-client'
const REGISTERED_REDIRECT = 'http://localhost:3000/callback'
const CLIENT_HOME = 'http://localhost:3000/'

interface Logged { message: string; data: unknown }
const warnings: Logged[] = []
const noop = () => {}
const authChannel = { error: noop, info: noop, debug: noop, trace: noop, warn: (message: string, data: unknown) => warnings.push({ message, data }) }

mockLoggerModule({
  logger: new Proxy<Record<string, unknown>>({}, { get: (_target, prop) => (prop === 'auth' ? authChannel : noopLogger[String(prop)]) }),
})
mockAuthRouteModules({ validateToken: async () => ({ sub: 'test-user' }) })
globalThis.fetch = keycloakFetch()

mock.module('@/lib/smart-client-config-cache', () => ({
  getSmartClientConfig: async () => ({ redirectUris: [REGISTERED_REDIRECT] }),
  getRegisteredRedirectUris: async (clientId: string) => (clientId === CLIENT_ID ? [REGISTERED_REDIRECT] : []),
  getPreferredIdentityProvider: async () => undefined,
  getRequiredAcr: async () => undefined,
  getClientHomeUrl: async (clientId: string) => (clientId === CLIENT_ID ? CLIENT_HOME : undefined),
  getClientUserRestrictions: async () => ({ allowedFhirUserTypes: [], requiredRoles: [] }),
  invalidateClientConfig: () => {},
  clearClientConfigCache: () => {},
}))

const { authRoutes } = await import('../src/routes/auth')
const { LOGIN_CLIENT_COOKIE } = await import('../src/lib/login-client-cookie')

const AUTHORIZE_PARAMS = {
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REGISTERED_REDIRECT,
  scope: 'openid launch/patient patient/*.rs',
  state: 'app-state',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  aud: `${TEST_BASE_URL}/mcp`,
}

const returnTo = (query = '', cookie?: string) =>
  authRoutes.handle(testRequest(`/auth/return${query}`, cookie ? { headers: { cookie } } : undefined))

const reportError = (body: string) =>
  authRoutes.handle(testRequest('/auth/login-error', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body }))

describe('the way back to the application', () => {
  useTestEnv(BASE_TEST_ENV)

  it('remembers the launching client when /auth/authorize hands off to the identity provider', async () => {
    const res = await authRoutes.handle(testRequest(`/auth/authorize?${new URLSearchParams(AUTHORIZE_PARAMS)}`))

    expect(res.status).toBe(302)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toStartWith(`${LOGIN_CLIENT_COOKIE}=${CLIENT_ID};`)
    expect(cookie).toContain('Path=/auth')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('returns to the remembered client when the error page sent no client_id', async () => {
    const res = await returnTo('', `other=1; ${LOGIN_CLIENT_COOKIE}=${CLIENT_ID}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(CLIENT_HOME)
  })

  it('prefers the client_id the error page sent', async () => {
    const res = await returnTo('?client_id=unknown-app', `${LOGIN_CLIENT_COOKIE}=${CLIENT_ID}`)
    expect(res.headers.get('location')).not.toBe(CLIENT_HOME)
  })

  it('falls back to the site when nothing names a registered client', async () => {
    const res = await returnTo('', `${LOGIN_CLIENT_COOKIE}=%00bad`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).not.toBe(CLIENT_HOME)
  })
})

describe('POST /auth/login-error', () => {
  useTestEnv(BASE_TEST_ENV)
  beforeEach(() => { warnings.length = 0 })

  it('logs what the login page showed', async () => {
    const res = await reportError(JSON.stringify({ clientId: CLIENT_ID, message: 'Invalid Request', page: '/realms/r/broker/idp/endpoint' }))

    expect(res.status).toBe(204)
    expect(warnings).toEqual([{
      message: 'Login page showed an error',
      data: { clientId: CLIENT_ID, message: 'Invalid Request', page: '/realms/r/broker/idp/endpoint' },
    }])
  })

  it('refuses a body that is not a report', async () => {
    expect((await reportError('not json')).status).toBe(400)
    expect((await reportError(JSON.stringify({ message: 'x' }))).status).toBe(400)
    expect(warnings).toHaveLength(0)
  })

  it('refuses an oversized body', async () => {
    const res = await reportError(JSON.stringify({ message: 'x'.repeat(3000), page: '/' }))
    expect(res.status).toBe(413)
    expect(warnings).toHaveLength(0)
  })
})
