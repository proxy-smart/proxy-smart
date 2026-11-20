// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * issuer-identification.test.ts — RFC 9207 Authorization Server Issuer Identification.
 *
 * MCP 2026-07-28 has clients record the `issuer` from the authorization server
 * metadata they validated, then compare it against the `iss` on the authorization
 * response using SIMPLE STRING COMPARISON, with normalization explicitly forbidden.
 *
 * The proxy advertises `issuer` = its own base URL (RFC 8414 §3.3 requires the
 * issuer to match the URL the metadata was fetched from). If the IdP redirects
 * straight to the client, the response carries the IdP's realm issuer instead and
 * the comparison fails. So the proxy must intercept the callback for any resource
 * whose clients discovered IT as the authorization server, and emit its own `iss`.
 *
 * SMART launches were already intercepted for launch context; these tests pin the
 * two things that were not covered: interception on a non-SMART MCP request, and
 * `iss` on every authorization response the proxy emits.
 */

import { describe, test, expect } from 'bun:test'
import { handleAuthorize, type AuthorizeInterceptorDeps } from './authorize-interceptor'
import { handleCallback, handlePatientSelect } from './callback-handler'
import { MemoryStore } from './stores/memory'
import {
  TEST_BASE_URL,
  makeAuthorizeDeps,
  makeAuthorizeParams,
  makeCallbackDeps,
  makeLaunchSession,
  testProxyConfig,
} from './test-fixtures'

const MCP_RESOURCE = `${TEST_BASE_URL}/mcp`
const CALLBACK_PATH = '/auth/smart-callback'
const CLIENT_ID = 'mcp-client'
const REGISTERED_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const MCP_SCOPE = 'openid profile email'

const CONFIG = testProxyConfig({ callbackPath: CALLBACK_PATH, interceptedResourceUrls: [MCP_RESOURCE] })

const AUTHORIZE = {
  config: CONFIG,
  clientId: CLIENT_ID,
  redirectUris: [REGISTERED_REDIRECT],
  validateAudience: async () => null,
}

/** An MCP client's authorize request: no SMART scopes, RFC 8707 resource present. */
const MCP_AUTHORIZE = { client_id: CLIENT_ID, redirect_uri: REGISTERED_REDIRECT, scope: MCP_SCOPE, resource: MCP_RESOURCE }

const SESSION = { clientRedirectUri: REGISTERED_REDIRECT, clientId: CLIENT_ID, scope: MCP_SCOPE, needsPatientPicker: false }

describe('callback interception for proxy-issued resources', () => {
  test('intercepts a non-SMART request that targets the MCP resource', async () => {
    const store = new MemoryStore()
    const { result, sessionKey } = await handleAuthorize(makeAuthorizeParams(MCP_AUTHORIZE), makeAuthorizeDeps(store, AUTHORIZE))

    expect(result.type).toBe('redirect')
    expect(sessionKey).toBeDefined()
    if (result.type !== 'redirect') return

    const url = new URL(result.url)
    // The IdP must send the code to US, not to the client, or the response the
    // client sees carries the IdP's iss.
    expect(url.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}${CALLBACK_PATH}`)
    expect(url.searchParams.get('state')).toBe(sessionKey)
    // The client's own state is preserved for the eventual redirect back.
    expect(store.get(sessionKey!)?.clientState).toBe('client-state-123')
  })

  test('intercepts any client the IdP lets return to the proxy, whatever the resource', async () => {
    const PROXY_CALLBACK = `${TEST_BASE_URL}${CALLBACK_PATH}`
    const deps = (redirectUris: string[]): AuthorizeInterceptorDeps => ({
      ...makeAuthorizeDeps(new MemoryStore(), { ...AUTHORIZE, config: testProxyConfig({ callbackPath: CALLBACK_PATH }) }),
      getRegisteredRedirectUris: async () => redirectUris,
    })
    const otherResource = makeAuthorizeParams({ ...MCP_AUTHORIZE, resource: 'https://imaging.example.com/mcp' })
    const noResource = makeAuthorizeParams({ client_id: CLIENT_ID, redirect_uri: REGISTERED_REDIRECT, scope: MCP_SCOPE })

    for (const params of [otherResource, noResource]) {
      const { result } = await handleAuthorize(params, deps([REGISTERED_REDIRECT, PROXY_CALLBACK]))
      if (result.type !== 'redirect') throw new Error('expected redirect')
      expect(new URL(result.url).searchParams.get('redirect_uri')).toBe(PROXY_CALLBACK)
    }

    const { result } = await handleAuthorize(otherResource, deps([REGISTERED_REDIRECT]))
    if (result.type !== 'redirect') throw new Error('expected redirect')
    expect(new URL(result.url).searchParams.get('redirect_uri')).toBe(REGISTERED_REDIRECT)
  })

  describe('CIMD clients', () => {
    const CIMD_ID = 'https://claude.ai/api/mcp/client-metadata.json'
    const cimdDeps = (overrides: Partial<AuthorizeInterceptorDeps> = {}): AuthorizeInterceptorDeps => ({
      ...makeAuthorizeDeps(new MemoryStore(), AUTHORIZE),
      getRegisteredRedirectUris: async (id) => (id === CIMD_ID ? [REGISTERED_REDIRECT] : []),
      standInForCimdClient: async () => null,
      ...overrides,
    })

    test('readies the stand-in, then intercepts so the IdP only ever sees the proxy callback', async () => {
      const readied: string[] = []
      const { result, sessionKey } = await handleAuthorize(
        makeAuthorizeParams({ ...MCP_AUTHORIZE, client_id: CIMD_ID }),
        cimdDeps({ standInForCimdClient: async (id) => { readied.push(id); return null } }),
      )

      expect(readied).toEqual([CIMD_ID])
      expect(sessionKey).toBeDefined()
      if (result.type !== 'redirect') throw new Error('expected redirect')
      const url = new URL(result.url)
      expect(url.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}${CALLBACK_PATH}`)
      expect(url.searchParams.get('client_id')).toBe(CIMD_ID)
    })

    test('intercepts whatever the resource, since the stand-in knows no other redirect', async () => {
      const params = makeAuthorizeParams({ client_id: CIMD_ID, redirect_uri: REGISTERED_REDIRECT, scope: MCP_SCOPE })
      const { result, sessionKey } = await handleAuthorize(params, cimdDeps())

      expect(sessionKey).toBeDefined()
      if (result.type !== 'redirect') throw new Error('expected redirect')
      expect(new URL(result.url).searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}${CALLBACK_PATH}`)
    })

    test('rejects a redirect_uri the document does not list', async () => {
      const { result } = await handleAuthorize(
        makeAuthorizeParams({ ...MCP_AUTHORIZE, client_id: CIMD_ID }),
        cimdDeps({ getRegisteredRedirectUris: async () => ['https://somewhere-else.example.com/cb'] }),
      )

      if (result.type !== 'error') throw new Error('expected error')
      expect(result.status).toBe(400)
      expect(result.error_description).toContain('redirect_uri')
    })

    test('refuses without reaching the IdP when the stand-in cannot be readied', async () => {
      const refusal = { error: 'unauthorized_client' as const, error_description: 'claude.ai is not a trusted client domain' }
      const { result, sessionKey } = await handleAuthorize(
        makeAuthorizeParams({ ...MCP_AUTHORIZE, client_id: CIMD_ID }),
        cimdDeps({ standInForCimdClient: async () => refusal }),
      )

      expect(sessionKey).toBeUndefined()
      expect(result).toEqual({ type: 'error', status: 400, ...refusal })
    })

    test('answers 503 when the stand-in is temporarily unavailable', async () => {
      const { result } = await handleAuthorize(
        makeAuthorizeParams({ ...MCP_AUTHORIZE, client_id: CIMD_ID }),
        cimdDeps({ standInForCimdClient: async () => ({ error: 'temporarily_unavailable', error_description: 'down' }) }),
      )

      expect(result.type === 'error' && result.status).toBe(503)
    })

    test('refuses CIMD outright when the deployment provides no stand-in', async () => {
      const { result } = await handleAuthorize(
        makeAuthorizeParams({ ...MCP_AUTHORIZE, client_id: CIMD_ID }),
        cimdDeps({ standInForCimdClient: undefined }),
      )

      expect(result.type === 'error' && result.error).toBe('unauthorized_client')
    })

    test('requires a redirect_uri, which the stand-in cannot default to', async () => {
      const { result } = await handleAuthorize(
        makeAuthorizeParams({ ...MCP_AUTHORIZE, client_id: CIMD_ID, redirect_uri: undefined }),
        cimdDeps(),
      )

      expect(result.type === 'error' && result.error).toBe('invalid_request')
    })
  })

  test('does NOT intercept a non-SMART request for an unlisted resource', async () => {
    const store = new MemoryStore()
    const { result, sessionKey } = await handleAuthorize(
      makeAuthorizeParams({ ...MCP_AUTHORIZE, resource: 'https://other.example.com/api' }),
      makeAuthorizeDeps(store, AUTHORIZE),
    )

    expect(sessionKey).toBeUndefined()
    if (result.type !== 'redirect') throw new Error('expected redirect')
    const url = new URL(result.url)
    expect(url.searchParams.get('redirect_uri')).toBe(REGISTERED_REDIRECT)
    expect(url.searchParams.get('state')).toBe('client-state-123')
  })

  test('does NOT intercept a plain OIDC login with no resource at all', async () => {
    const store = new MemoryStore()
    const params = makeAuthorizeParams(MCP_AUTHORIZE)
    delete params.resource
    const { result, sessionKey } = await handleAuthorize(params, makeAuthorizeDeps(store, AUTHORIZE))

    expect(sessionKey).toBeUndefined()
    if (result.type !== 'redirect') throw new Error('expected redirect')
    expect(new URL(result.url).searchParams.get('redirect_uri')).toBe(REGISTERED_REDIRECT)
  })
})

describe('RFC 9207 — iss on every authorization response', () => {
  test('success redirect carries iss equal to the advertised issuer, verbatim', async () => {
    const store = new MemoryStore()
    store.set('sess-1', makeLaunchSession(SESSION))

    const { result } = await handleCallback({ state: 'sess-1', code: 'auth-code' }, makeCallbackDeps(store, { config: CONFIG }))

    if (result.type !== 'redirect') throw new Error('expected redirect')
    const url = new URL(result.url)
    expect(url.searchParams.get('code')).toBe('auth-code')
    expect(url.searchParams.get('state')).toBe('client-state-123')
    // Simple string comparison, no normalization — not the IdP realm issuer, and
    // not a trailing-slash or case variant of our own base URL.
    expect(url.searchParams.get('iss')).toBe(TEST_BASE_URL)
  })

  test('error redirect carries iss too (RFC 9207 §2)', async () => {
    const store = new MemoryStore()
    store.set('sess-2', makeLaunchSession(SESSION))

    const { result } = await handleCallback(
      { state: 'sess-2', error: 'access_denied', error_description: 'User said no' },
      makeCallbackDeps(store, { config: CONFIG }),
    )

    if (result.type !== 'redirect') throw new Error('expected redirect')
    const url = new URL(result.url)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('iss')).toBe(TEST_BASE_URL)
  })

  test('patient picker redirect carries iss', () => {
    const store = new MemoryStore()
    store.set('sess-3', makeLaunchSession({ ...SESSION, needsPatientPicker: true, pickerAllowed: true }))

    const result = handlePatientSelect(
      { session: 'sess-3', code: 'auth-code', patient: 'Patient/123' },
      makeCallbackDeps(store, { config: CONFIG }),
    )

    if (result.type !== 'redirect') throw new Error('expected redirect')
    expect(new URL(result.url).searchParams.get('iss')).toBe(TEST_BASE_URL)
  })

  test('duplicate picker submission still carries iss', () => {
    const store = new MemoryStore()
    store.set('sess-4', makeLaunchSession({ ...SESSION, needsPatientPicker: false, patient: 'Patient/123' }))

    const result = handlePatientSelect(
      { session: 'sess-4', code: 'auth-code', patient: 'Patient/123' },
      makeCallbackDeps(store, { config: CONFIG }),
    )

    if (result.type !== 'redirect') throw new Error('expected redirect')
    expect(new URL(result.url).searchParams.get('iss')).toBe(TEST_BASE_URL)
  })
})
