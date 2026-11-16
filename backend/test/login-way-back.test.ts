// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The error pages lead back through /auth/return to a registered home only, and every authorize and
 * callback step reaches the OAuth monitoring events, so a failed sign-in can be traced.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mockLoggerModule, noopLogger } from './helpers/mock-logger'
import { BASE_TEST_ENV, TEST_BASE_URL, testRequest, useTestEnv } from './helpers/test-env'
import { keycloakFetch } from './helpers/fake-fetch'
import { mockAuthRouteModules } from './helpers/oauth-routes'

const CLIENT_ID = 'smart-app-client'
const REGISTERED_REDIRECT = 'http://localhost:3000/callback'
const CLIENT_HOME = 'http://localhost:3000/'

interface Recorded { type: string; status: string; clientId: string; errorCode?: string; requestDetails?: { path: string; method: string } }
const recorded: Recorded[] = []

mockLoggerModule({ logger: noopLogger })
mockAuthRouteModules({ validateToken: async () => ({ sub: 'test-user' }), logEvent: (event) => { recorded.push(event) } })
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

const returnTo = (query = '') => authRoutes.handle(testRequest(`/auth/return${query}`))

describe('the way back to the application', () => {
  useTestEnv(BASE_TEST_ENV)

  it('sets no cookie when /auth/authorize hands off to the identity provider', async () => {
    const res = await authRoutes.handle(testRequest(`/auth/authorize?${new URLSearchParams(AUTHORIZE_PARAMS)}`))
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it("returns to the named client's registered home", async () => {
    const res = await returnTo(`?client_id=${CLIENT_ID}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(CLIENT_HOME)
  })

  it('falls back to the site when nothing names a registered client', async () => {
    for (const query of ['', '?client_id=unknown-app']) {
      const res = await returnTo(query)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).not.toBe(CLIENT_HOME)
    }
  })
})

describe('authorization steps in OAuth monitoring', () => {
  useTestEnv(BASE_TEST_ENV)
  beforeEach(() => { recorded.length = 0 })

  it('records a hand-off to the identity provider as a successful authorization', async () => {
    await authRoutes.handle(testRequest(`/auth/authorize?${new URLSearchParams(AUTHORIZE_PARAMS)}`))
    expect(recorded).toEqual([expect.objectContaining({
      type: 'authorization',
      status: 'success',
      clientId: CLIENT_ID,
      requestDetails: expect.objectContaining({ path: '/auth/authorize', method: 'GET' }),
    })])
  })

  it('records a refused authorization with its error', async () => {
    await authRoutes.handle(testRequest(`/auth/authorize?${new URLSearchParams({ ...AUTHORIZE_PARAMS, redirect_uri: 'https://elsewhere.example/cb' })}`))
    expect(recorded).toEqual([expect.objectContaining({ type: 'authorization', status: 'error', clientId: CLIENT_ID, errorCode: 'invalid_request' })])
  })

  it('records a callback whose sign-in session is gone', async () => {
    await authRoutes.handle(testRequest('/auth/smart-callback?state=unknown-state&code=c'))
    expect(recorded).toEqual([expect.objectContaining({
      type: 'authorization',
      status: 'error',
      clientId: 'unknown',
      errorCode: 'invalid_request',
      requestDetails: expect.objectContaining({ path: '/auth/smart-callback' }),
    })])
  })
})
