// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { handleAuthorize, type AuthorizeInterceptorDeps } from './authorize-interceptor'
import { signLaunchCode, toLaunchCodeOptions, verifyLaunchCode } from './launch-code'
import { MemoryStore } from './stores/memory'
import { PKCE_PARAMS } from './test-fixtures'
import type { AuthorizeParams, LaunchCodePayload, SmartProxyConfig, SmartProxyResult } from './types'
import type { IdPAdapter } from './idp/interface'

const BASE_URL = 'https://proxy.example.com'
const FHIR_BASE = `${BASE_URL}/proxy/hapi/R4`
const OTHER_FHIR_BASE = `${BASE_URL}/proxy/other/R4`
const CLIENT_ID = 'smart-app'
const REDIRECT = 'https://app.example.com/callback'
const IDP_AUTHORIZE = 'https://kc.example.com/realms/test/protocol/openid-connect/auth'

const CONFIG: SmartProxyConfig = {
  baseUrl: BASE_URL,
  callbackPath: '/auth/smart-callback',
  launchCodeSecret: 'test-secret-key-for-testing-only',
  launchCodeTtlSeconds: 300,
}

const idp: IdPAdapter = {
  getAuthorizationUrl: () => IDP_AUTHORIZE,
  getTokenUrl: () => 'https://kc.example.com/token',
  getIntrospectionUrl: () => 'https://kc.example.com/introspect',
  getLogoutUrl: () => 'https://kc.example.com/logout',
}

const KNOWN_AUDIENCES = new Set([FHIR_BASE, OTHER_FHIR_BASE])

function deps(store = new MemoryStore(), overrides: Partial<AuthorizeInterceptorDeps> = {}): AuthorizeInterceptorDeps {
  return {
    config: CONFIG,
    store,
    idp,
    getRegisteredRedirectUris: async (clientId) => (clientId === CLIENT_ID ? [REDIRECT] : []),
    validateAudience: async (aud) => (KNOWN_AUDIENCES.has(aud) ? null : 'aud does not name a FHIR server on this proxy'),
    ...overrides,
  }
}

function params(overrides: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: 'openid fhirUser launch/patient patient/*.rs',
    state: 'state-1',
    aud: FHIR_BASE,
    ...PKCE_PARAMS,
    ...overrides,
  }
}

function errorRedirect(result: SmartProxyResult): URL {
  if (result.type !== 'redirect') throw new Error(`expected a redirect, got ${JSON.stringify(result)}`)
  const url = new URL(result.url)
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT)
  expect(url.searchParams.get('state')).toBe('state-1')
  expect(url.searchParams.get('iss')).toBe(BASE_URL)
  return url
}

const launchOptions = toLaunchCodeOptions(CONFIG)
const launchCode = (payload: LaunchCodePayload) => signLaunchCode(payload, launchOptions)

describe('PKCE (SMART: S256 SHALL be supported, plain SHALL NOT)', () => {
  test('a request without code_challenge is refused on the registered redirect_uri', async () => {
    const store = new MemoryStore()
    const { result } = await handleAuthorize(params({ code_challenge: undefined, code_challenge_method: undefined }), deps(store))

    const url = errorRedirect(result)
    expect(url.searchParams.get('error')).toBe('invalid_request')
    expect(url.searchParams.get('error_description')).toContain('code_challenge')
    expect(store.size()).toBe(0)
  })

  test('the plain method is refused', async () => {
    const { result } = await handleAuthorize(params({ code_challenge_method: 'plain' }), deps())
    expect(errorRedirect(result).searchParams.get('error')).toBe('invalid_request')
  })

  test('a challenge without a method is refused, since RFC 7636 defaults that to plain', async () => {
    const { result } = await handleAuthorize(params({ code_challenge_method: undefined }), deps())
    expect(errorRedirect(result).searchParams.get('error')).toBe('invalid_request')
  })

  test('a challenge that cannot be a SHA-256 digest is refused', async () => {
    const { result } = await handleAuthorize(params({ code_challenge: 'abc123' }), deps())
    expect(errorRedirect(result).searchParams.get('error')).toBe('invalid_request')
  })

  test('a plain request that is not SMART still needs PKCE', async () => {
    const { result } = await handleAuthorize(
      params({ scope: 'openid profile', aud: undefined, code_challenge: undefined, code_challenge_method: undefined }),
      deps(),
    )
    expect(errorRedirect(result).searchParams.get('error')).toBe('invalid_request')
  })

  test('an unregistered redirect_uri gets a 400 instead of a redirect', async () => {
    const { result } = await handleAuthorize(
      params({ redirect_uri: 'https://attacker.example/cb', code_challenge: undefined }),
      deps(),
    )
    expect(result).toMatchObject({ type: 'error', status: 400, error: 'invalid_request' })
  })

  test('an S256 challenge reaches the IdP unchanged', async () => {
    const { result } = await handleAuthorize(params(), deps())
    if (result.type !== 'redirect') throw new Error('expected a redirect')
    const url = new URL(result.url)
    expect(url.href.startsWith(IDP_AUTHORIZE)).toBe(true)
    expect(url.searchParams.get('code_challenge')).toBe(PKCE_PARAMS.code_challenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })
})

describe('aud (SMART: required, and it names the FHIR server)', () => {
  test('a SMART request without aud or resource is refused', async () => {
    const { result } = await handleAuthorize(params({ aud: undefined }), deps())
    const url = errorRedirect(result)
    expect(url.searchParams.get('error')).toBe('invalid_request')
    expect(url.searchParams.get('error_description')).toContain('aud')
  })

  test('a user-level SMART request needs aud too', async () => {
    const { result } = await handleAuthorize(params({ scope: 'openid user/*.rs', aud: undefined }), deps())
    expect(errorRedirect(result).searchParams.get('error')).toBe('invalid_request')
  })

  test('resource is accepted in place of aud', async () => {
    const { result } = await handleAuthorize(params({ aud: undefined, resource: FHIR_BASE }), deps())
    expect(result.type === 'redirect' && result.url.startsWith(IDP_AUTHORIZE)).toBe(true)
  })

  test('an unknown aud is answered with invalid_target on the client redirect', async () => {
    const { result } = await handleAuthorize(params({ aud: 'https://evil.example.com/fhir' }), deps())
    expect(errorRedirect(result).searchParams.get('error')).toBe('invalid_target')
  })

  test('an unknown aud with an unregistered redirect_uri is a 400, never a redirect', async () => {
    const { result } = await handleAuthorize(
      params({ aud: 'https://evil.example.com/fhir', redirect_uri: 'https://attacker.example/cb' }),
      deps(),
    )
    expect(result).toMatchObject({ type: 'error', status: 400, error: 'invalid_target' })
  })

  test('a request without SMART scopes may leave aud out', async () => {
    const { result } = await handleAuthorize(params({ scope: 'openid profile', aud: undefined }), deps())
    expect(result.type === 'redirect' && result.url.startsWith(IDP_AUTHORIZE)).toBe(true)
  })
})

describe('EHR launch codes', () => {
  test('aud must be the FHIR base the launch was minted for (aud equals the launch iss)', async () => {
    const code = launchCode({ patient: 'p-1', clientId: CLIENT_ID, fhirBase: FHIR_BASE })
    const { result } = await handleAuthorize(params({ launch: code, scope: 'openid launch patient/*.rs', aud: OTHER_FHIR_BASE }), deps())
    expect(errorRedirect(result).searchParams.get('error')).toBe('invalid_target')
  })

  test('the matching aud is accepted', async () => {
    const code = launchCode({ patient: 'p-1', clientId: CLIENT_ID, fhirBase: FHIR_BASE })
    const { result, resolvedLaunchContext } = await handleAuthorize(params({ launch: code, scope: 'openid launch patient/*.rs' }), deps())
    expect(result.type === 'redirect' && result.url.startsWith(IDP_AUTHORIZE)).toBe(true)
    expect(resolvedLaunchContext?.patient).toBe('p-1')
  })

  test('a launch code bound to no client is refused', async () => {
    const code = launchCode({ patient: 'p-1' })
    const { result } = await handleAuthorize(params({ launch: code, scope: 'openid launch patient/*.rs' }), deps())
    expect(errorRedirect(result).searchParams.get('error')).toBe('invalid_request')
  })

  test('a launch code is spent by its first authorization request', async () => {
    const spent = new Set<string>()
    const claimLaunchCode = async (jti: string) => {
      if (spent.has(jti)) return false
      spent.add(jti)
      return true
    }
    const code = launchCode({ patient: 'p-1', clientId: CLIENT_ID })
    const first = await handleAuthorize(params({ launch: code, scope: 'openid launch patient/*.rs' }), deps(new MemoryStore(), { claimLaunchCode }))
    expect(first.result.type === 'redirect' && first.result.url.startsWith(IDP_AUTHORIZE)).toBe(true)

    const second = await handleAuthorize(params({ launch: code, scope: 'openid launch patient/*.rs' }), deps(new MemoryStore(), { claimLaunchCode }))
    const url = errorRedirect(second.result)
    expect(url.searchParams.get('error')).toBe('invalid_request')
    expect(url.searchParams.get('error_description')).toContain('already been used')
  })

  test('a refused request does not spend the launch code', async () => {
    const claimed: string[] = []
    const claimLaunchCode = async (jti: string) => {
      claimed.push(jti)
      return true
    }
    const code = launchCode({ patient: 'p-1', clientId: CLIENT_ID })
    await handleAuthorize(params({ launch: code, aud: 'https://evil.example.com/fhir' }), deps(new MemoryStore(), { claimLaunchCode }))
    expect(claimed).toEqual([])
  })

  test('each code carries its own id and expiry, which verification returns', () => {
    const verified = verifyLaunchCode(launchCode({ patient: 'p-1', clientId: CLIENT_ID }), launchOptions)
    const other = verifyLaunchCode(launchCode({ patient: 'p-1', clientId: CLIENT_ID }), launchOptions)
    expect(verified?.jti).toBeTruthy()
    expect(verified?.jti).not.toBe(other?.jti)
    expect(verified?.expiresAt).toBeGreaterThan(Date.now())
  })

  test('a launch code without a patient leaves patient selection to the picker when patient scopes are asked for', async () => {
    const store = new MemoryStore()
    const code = launchCode({ encounter: 'e-1', clientId: CLIENT_ID })
    const { sessionKey } = await handleAuthorize(params({ launch: code, scope: 'openid launch patient/*.rs' }), deps(store))
    expect(sessionKey).toBeDefined()
    expect(store.get(sessionKey ?? '')?.needsPatientPicker).toBe(true)
  })

  test('a launch code without a patient needs no picker when nothing patient-level was asked for', async () => {
    const store = new MemoryStore()
    const code = launchCode({ fhirUser: 'Practitioner/1', clientId: CLIENT_ID })
    const { sessionKey } = await handleAuthorize(params({ launch: code, scope: 'openid launch user/*.rs' }), deps(store))
    expect(store.get(sessionKey ?? '')?.needsPatientPicker).toBe(false)
  })
})
