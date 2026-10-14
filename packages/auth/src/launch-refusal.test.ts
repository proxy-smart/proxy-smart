// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { handleAuthorize, type AuthorizeInterceptorDeps } from './authorize-interceptor'
import { signLaunchCode, toLaunchCodeOptions } from './launch-code'
import { MemoryStore } from './stores/memory'
import {
  TEST_BASE_URL,
  TEST_IDP_AUTHORIZE_URL,
  TEST_REDIRECT_URI,
  makeAuthorizeDeps,
  makeAuthorizeParams,
  testProxyConfig,
} from './test-fixtures'
import type { AuthorizeParams } from './types'

const CLIENT_ID = 'ehr-app'

const CONFIG = testProxyConfig({ callbackPath: '/auth/smart-callback', launchCodeTtlSeconds: 300 })

function deps(store: MemoryStore, registered: string[] | null = [TEST_REDIRECT_URI]): AuthorizeInterceptorDeps {
  return makeAuthorizeDeps(store, { config: CONFIG, clientId: CLIENT_ID, redirectUris: registered })
}

function params(launch: string, overrides: AuthorizeParams = {}): AuthorizeParams {
  return makeAuthorizeParams({
    client_id: CLIENT_ID,
    scope: 'openid launch patient/*.rs',
    state: 'app-state-1',
    aud: 'https://proxy.example.com/proxy-smart-backend/hapi/R4',
    launch,
    ...overrides,
  })
}

const options = toLaunchCodeOptions(CONFIG)

describe('authorize refuses a launch value it cannot honour', () => {
  test('an unverifiable launch value is answered with an error redirect to the registered redirect_uri', async () => {
    const store = new MemoryStore()

    const { result, sessionKey } = await handleAuthorize(params('not-a-launch-code'), deps(store))

    expect(result.type).toBe('redirect')
    if (result.type !== 'redirect') return
    const location = new URL(result.url)
    expect(`${location.origin}${location.pathname}`).toBe(TEST_REDIRECT_URI)
    expect(location.searchParams.get('error')).toBe('invalid_request')
    expect(location.searchParams.get('error_description')).toContain('launch')
    expect(location.searchParams.get('state')).toBe('app-state-1')
    expect(location.searchParams.get('iss')).toBe(TEST_BASE_URL)
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
    expect(location.origin).toBe(new URL(TEST_REDIRECT_URI).origin)
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
    expect(result.url.startsWith(TEST_IDP_AUTHORIZE_URL)).toBe(true)
    expect(resolvedLaunchContext?.patient).toBe('p-7')
  })
})
