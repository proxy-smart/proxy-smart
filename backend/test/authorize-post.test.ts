// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { TEST_BASE_URL, TEST_KC_BASE_URL, TEST_REALM, BASE_TEST_ENV, useTestEnv } from './helpers/test-env'
import { isRealmProbe, requestUrl } from './helpers/fake-fetch'

const TEST_CLIENT_ID = 'smart-app-client'
const REGISTERED_REDIRECT = 'http://localhost:3000/callback'

mockLoggerModule()

mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

mock.module('cross-fetch', () => ({
  default: async (url: string | URL | Request) => {
    const urlStr = requestUrl(url)
    const realmProbe = isRealmProbe(urlStr)
    return new Response('{}', { status: realmProbe ? 200 : 404 })
  },
}))

mock.module('@/lib/kc-session-resolver', () => ({
  autoResolvePatient: async () => null,
}))

mock.module('@/lib/auth', () => ({
  validateToken: async () => ({ sub: 'test-user' }),
}))

mock.module('@/lib/smart-client-config-cache', () => ({
  getSmartClientConfig: async () => ({ redirectUris: [REGISTERED_REDIRECT] }),
  getRegisteredRedirectUris: async (clientId: string) => (clientId === TEST_CLIENT_ID ? [REGISTERED_REDIRECT] : []),
  invalidateClientConfig: () => {},
  clearClientConfigCache: () => {},
}))

import { authRoutes } from '../src/routes/auth'
import { launchContextStore } from '../src/lib/launch-context-store'

const AUTHORIZE_PARAMS = {
  response_type: 'code',
  client_id: TEST_CLIENT_ID,
  redirect_uri: REGISTERED_REDIRECT,
  scope: 'openid launch/patient patient/*.rs',
  state: 'app-state',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  aud: `${TEST_BASE_URL}/mcp`,
}

const getAuthorize = (params: Record<string, string>) =>
  authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/authorize?${new URLSearchParams(params)}`))

const postAuthorize = (params: Record<string, string>) =>
  authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  }))

/** The Keycloak query a redirect carries, minus the per-request session key. */
function idpQuery(res: Response): Record<string, string> {
  const location = new URL(res.headers.get('location') ?? '')
  const query = Object.fromEntries(location.searchParams.entries())
  delete query.state
  return query
}

describe('POST /auth/authorize (SMART authorize-post)', () => {
  useTestEnv({ ...BASE_TEST_ENV, SMART_LAUNCH_CODE_TTL_SECONDS: '300' })

  afterEach(() => {
    launchContextStore.dispose()
  })

  it('accepts the authorize parameters as a form and redirects to the IdP with 303', async () => {
    const res = await postAuthorize(AUTHORIZE_PARAMS)

    expect(res.status).toBe(303)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.href.startsWith(`${TEST_KC_BASE_URL}/realms/${TEST_REALM}/protocol/openid-connect/auth`)).toBe(true)
    expect(location.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}/auth/smart-callback`)
    expect(location.searchParams.get('code_challenge')).toBe(AUTHORIZE_PARAMS.code_challenge)
    expect(launchContextStore.size()).toBe(1)
  })

  it('sends the IdP exactly what the GET form of the same request sends', async () => {
    const viaGet = await getAuthorize(AUTHORIZE_PARAMS)
    const viaPost = await postAuthorize(AUTHORIZE_PARAMS)

    expect(viaGet.status).toBe(302)
    expect(idpQuery(viaPost)).toEqual(idpQuery(viaGet))
  })

  it('applies the same redirect_uri allowlist as GET', async () => {
    const res = await postAuthorize({ ...AUTHORIZE_PARAMS, redirect_uri: 'https://attacker.example/steal' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request')
    expect(launchContextStore.size()).toBe(0)
  })

  it('refuses an invalid launch value with an error redirect to the app', async () => {
    const res = await postAuthorize({ ...AUTHORIZE_PARAMS, scope: 'openid launch patient/*.rs', launch: 'expired-or-forged' })

    expect(res.status).toBe(303)
    const location = new URL(res.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(REGISTERED_REDIRECT)
    expect(location.searchParams.get('error')).toBe('invalid_request')
    expect(location.searchParams.get('state')).toBe('app-state')
  })

  it('refuses an invalid launch value on GET the same way', async () => {
    const res = await getAuthorize({ ...AUTHORIZE_PARAMS, scope: 'openid launch patient/*.rs', launch: 'expired-or-forged' })

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(REGISTERED_REDIRECT)
    expect(location.searchParams.get('error')).toBe('invalid_request')
  })
})
