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

  test('intercepts a CIMD client whose metadata document lists the redirect_uri', async () => {
    // A CIMD client_id is a URL and the IdP holds no record of it, so the
    // allowlist comes from the metadata document. Once the injected resolver
    // knows how to read it, interception needs no special case — and the
    // fail-closed check stays fail-closed.
    const store = new MemoryStore()
    const CIMD_ID = 'https://claude.ai/api/mcp/client-metadata.json'
    const deps: AuthorizeInterceptorDeps = {
      ...makeAuthorizeDeps(store, AUTHORIZE),
      // Stands in for the resolver that fetches and validates the document.
      getRegisteredRedirectUris: async (id) => (id === CIMD_ID ? [REGISTERED_REDIRECT] : []),
    }

    const { result, sessionKey } = await handleAuthorize(
      makeAuthorizeParams({ ...MCP_AUTHORIZE, client_id: CIMD_ID }),
      deps,
    )

    expect(sessionKey).toBeDefined()
    if (result.type !== 'redirect') throw new Error('expected redirect')
    const url = new URL(result.url)
    expect(url.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}${CALLBACK_PATH}`)
    expect(url.searchParams.get('client_id')).toBe(CIMD_ID)
  })

  test('rejects a CIMD client whose document lists OTHER redirect_uris', async () => {
    const store = new MemoryStore()
    const deps: AuthorizeInterceptorDeps = {
      ...makeAuthorizeDeps(store, AUTHORIZE),
      // Document fetched and valid, but the requested URI is not in it. A valid
      // document always has at least one entry (the resolver rejects empty ones),
      // so a NON-EMPTY list that excludes the request is the real "not allowed".
      getRegisteredRedirectUris: async () => ['https://somewhere-else.example.com/cb'],
    }

    const { result } = await handleAuthorize(
      makeAuthorizeParams({ ...MCP_AUTHORIZE, client_id: 'https://claude.ai/api/mcp/client-metadata.json' }),
      deps,
    )

    expect(result.type).toBe('error')
    if (result.type !== 'error') return
    expect(result.status).toBe(400)
    expect(result.error_description).toContain('redirect_uri')
  })

  test('passes a CIMD client through unintercepted when the document cannot be read', async () => {
    // An empty list can only mean "unresolvable" — the resolver rejects documents
    // with no redirect_uris. Rejecting here would turn a bot-protected client host
    // or a transient outage into a failed login, for a request that worked before
    // interception existed. Stand aside and let the IdP validate instead.
    const store = new MemoryStore()
    const CIMD_ID = 'https://claude.ai/api/mcp/client-metadata.json'
    const deps: AuthorizeInterceptorDeps = {
      ...makeAuthorizeDeps(store, AUTHORIZE),
      getRegisteredRedirectUris: async () => [],
    }

    const { result, sessionKey } = await handleAuthorize(
      makeAuthorizeParams({ ...MCP_AUTHORIZE, client_id: CIMD_ID }),
      deps,
    )

    expect(sessionKey).toBeUndefined()
    if (result.type !== 'redirect') throw new Error('expected pass-through redirect')
    const url = new URL(result.url)
    expect(url.searchParams.get('client_id')).toBe(CIMD_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(REGISTERED_REDIRECT)
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
