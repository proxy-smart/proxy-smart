// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { handleAuthorize, type AuthorizeInterceptorDeps } from './authorize-interceptor'
import { signLaunchCode, toLaunchCodeOptions } from './launch-code'
import { MemoryStore } from './stores/memory'
import {
  AUTHORIZE_TEST_CONFIG,
  TEST_BASE_URL,
  TEST_REDIRECT_URI,
  errorRedirectOf,
  makeAuthorizeDeps,
  makeAuthorizeParams,
  reachesIdp,
} from './test-fixtures'
import type { AuthorizeParams } from './types'

const CLIENT_ID = 'ehr-app'

function deps(store: MemoryStore, registered: string[] | null = [TEST_REDIRECT_URI]): AuthorizeInterceptorDeps {
  return makeAuthorizeDeps(store, { config: AUTHORIZE_TEST_CONFIG, clientId: CLIENT_ID, redirectUris: registered })
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

const options = toLaunchCodeOptions(AUTHORIZE_TEST_CONFIG)

describe('authorize refuses a launch value it cannot honour', () => {
  test('an unverifiable launch value is answered with an error redirect to the registered redirect_uri', async () => {
    const store = new MemoryStore()

    const { result, sessionKey } = await handleAuthorize(params('not-a-launch-code'), deps(store))

    const refusal = errorRedirectOf(result)
    expect(refusal).toMatchObject({ target: TEST_REDIRECT_URI, error: 'invalid_request', state: 'app-state-1', iss: TEST_BASE_URL })
    expect(refusal.description).toContain('launch')
    expect(sessionKey).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  test('an expired launch code is refused the same way', async () => {
    const expired = signLaunchCode({ patient: 'p-1' }, { ...options, ttlSeconds: -10 })

    const { result } = await handleAuthorize(params(expired), deps(new MemoryStore()))

    expect(errorRedirectOf(result).error).toBe('invalid_request')
  })

  test('a launch code minted for another client is refused with an error redirect', async () => {
    const foreign = signLaunchCode({ patient: 'p-1', clientId: 'other-app' }, options)

    const { result } = await handleAuthorize(params(foreign), deps(new MemoryStore()))

    expect(errorRedirectOf(result)).toMatchObject({ target: TEST_REDIRECT_URI, error: 'invalid_request' })
  })

  test('the state is left out when the request carried none', async () => {
    const { result } = await handleAuthorize(params('bad', { state: undefined }), deps(new MemoryStore()))

    expect(errorRedirectOf(result).state).toBeNull()
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

    expect(reachesIdp(result)).toBe(true)
    expect(resolvedLaunchContext?.patient).toBe('p-7')
  })
})
