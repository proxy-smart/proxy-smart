// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { handleAuthorize, type AuthorizeInterceptorDeps } from './authorize-interceptor'
import { signLaunchCode, toLaunchCodeOptions } from './launch-code'
import { MemoryStore } from './stores/memory'
import type { AuthorizeParams, SmartProxyConfig } from './types'
import type { IdPAdapter } from './idp/interface'

const BASE_URL = 'https://proxy.example.com'
const CLIENT_ID = 'ehr-app'
const REGISTERED_REDIRECT = 'https://app.example.com/callback'
const IDP_AUTHORIZE = 'https://kc.example.com/realms/test/protocol/openid-connect/auth'

const CONFIG: SmartProxyConfig = {
  baseUrl: BASE_URL,
  callbackPath: '/auth/smart-callback',
  launchCodeSecret: 'test-secret-key-for-testing-only',
  launchCodeTtlSeconds: 300,
}

const idp: IdPAdapter = {
  getAuthorizationUrl: () => IDP_AUTHORIZE,
  getTokenUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/token',
  getIntrospectionUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/token/introspect',
  getLogoutUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/logout',
}

function deps(store: MemoryStore, registered: string[] | null = [REGISTERED_REDIRECT]): AuthorizeInterceptorDeps {
  return {
    config: CONFIG,
    store,
    idp,
    ...(registered && {
      getRegisteredRedirectUris: async (clientId: string) => (clientId === CLIENT_ID ? registered : []),
    }),
  }
}

function params(launch: string, overrides: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REGISTERED_REDIRECT,
    scope: 'openid launch patient/*.rs',
    state: 'app-state-1',
    launch,
    ...overrides,
  }
}

const options = toLaunchCodeOptions(CONFIG)

describe('authorize refuses a launch value it cannot honour', () => {
  test('an unverifiable launch value is answered with an error redirect to the registered redirect_uri', async () => {
    const store = new MemoryStore()

    const { result, sessionKey } = await handleAuthorize(params('not-a-launch-code'), deps(store))

    expect(result.type).toBe('redirect')
    if (result.type !== 'redirect') return
    const location = new URL(result.url)
    expect(`${location.origin}${location.pathname}`).toBe(REGISTERED_REDIRECT)
    expect(location.searchParams.get('error')).toBe('invalid_request')
    expect(location.searchParams.get('error_description')).toContain('launch')
    expect(location.searchParams.get('state')).toBe('app-state-1')
    expect(location.searchParams.get('iss')).toBe(BASE_URL)
    expect(sessionKey).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  test('an expired launch code is refused the same way', async () => {
    const expired = signLaunchCode({ patient: 'p-1' }, { ...options, ttlSeconds: -10 })

    const { result } = await handleAuthorize(params(expired), deps(new MemoryStore()))

    expect(result.type).toBe('redirect')
    if (result.type !== 'redirect') return
    expect(new URL(result.url).searchParams.get('error')).toBe('invalid_request')
  })

  test('a launch code minted for another client is refused with an error redirect', async () => {
    const foreign = signLaunchCode({ patient: 'p-1', clientId: 'other-app' }, options)

    const { result } = await handleAuthorize(params(foreign), deps(new MemoryStore()))

    expect(result.type).toBe('redirect')
    if (result.type !== 'redirect') return
    const location = new URL(result.url)
    expect(location.origin).toBe(new URL(REGISTERED_REDIRECT).origin)
    expect(location.searchParams.get('error')).toBe('invalid_request')
  })

  test('the state is left out when the request carried none', async () => {
    const { result } = await handleAuthorize(params('bad', { state: undefined }), deps(new MemoryStore()))

    expect(result.type).toBe('redirect')
    if (result.type !== 'redirect') return
    expect(new URL(result.url).searchParams.has('state')).toBe(false)
  })

  test('an unregistered redirect_uri gets a 400 and is never redirected to', async () => {
    const { result } = await handleAuthorize(
      params('bad', { redirect_uri: 'https://attacker.example/steal' }),
      deps(new MemoryStore()),
    )

    expect(result).toMatchObject({ type: 'error', status: 400, error: 'invalid_request' })
  })

  test('a 400 when the redirect_uri cannot be checked at all', async () => {
    const { result } = await handleAuthorize(params('bad'), deps(new MemoryStore(), null))

    expect(result).toMatchObject({ type: 'error', status: 400, error: 'invalid_request' })
  })

  test('a 400 when the registered redirect URIs cannot be loaded', async () => {
    const failing: AuthorizeInterceptorDeps = {
      ...deps(new MemoryStore()),
      getRegisteredRedirectUris: async () => { throw new Error('admin API down') },
    }

    const { result } = await handleAuthorize(params('bad'), failing)

    expect(result).toMatchObject({ type: 'error', status: 400 })
  })

  test('a valid launch code still reaches the IdP with its context', async () => {
    const store = new MemoryStore()
    const valid = signLaunchCode({ patient: 'p-7', clientId: CLIENT_ID }, options)

    const { result, resolvedLaunchContext } = await handleAuthorize(params(valid), deps(store))

    expect(result.type).toBe('redirect')
    if (result.type !== 'redirect') return
    expect(result.url.startsWith(IDP_AUTHORIZE)).toBe(true)
    expect(resolvedLaunchContext?.patient).toBe('p-7')
  })
})
