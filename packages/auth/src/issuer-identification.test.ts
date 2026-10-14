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
import { handleCallback, handlePatientSelect, type CallbackHandlerDeps } from './callback-handler'
import { MemoryStore } from './stores/memory'
import { PKCE_PARAMS } from './test-fixtures'
import type { AuthorizeParams, LaunchSession, SmartProxyConfig } from './types'
import type { IdPAdapter } from './idp/interface'

const BASE_URL = 'https://proxy.example.com'
const MCP_RESOURCE = `${BASE_URL}/mcp`
const CALLBACK_PATH = '/auth/smart-callback'
const CLIENT_ID = 'mcp-client'
const REGISTERED_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

const CONFIG: SmartProxyConfig = {
  baseUrl: BASE_URL,
  callbackPath: CALLBACK_PATH,
  launchCodeSecret: 'test-secret-key-for-testing-only',
  interceptedResourceUrls: [MCP_RESOURCE],
}

const idp: IdPAdapter = {
  getAuthorizationUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/auth',
  getTokenUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/token',
  getIntrospectionUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/token/introspect',
  getLogoutUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/logout',
}

function authorizeDeps(store: MemoryStore): AuthorizeInterceptorDeps {
  return {
    config: CONFIG,
    store,
    idp,
    validateAudience: async () => null,
    getRegisteredRedirectUris: async (clientId) =>
      clientId === CLIENT_ID ? [REGISTERED_REDIRECT] : [],
  }
}

function callbackDeps(store: MemoryStore): CallbackHandlerDeps {
  return { config: CONFIG, store }
}

/** An MCP client's authorize request: no SMART scopes, RFC 8707 resource present. */
function mcpAuthorizeParams(overrides: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REGISTERED_REDIRECT,
    scope: 'openid profile email',
    state: 'client-state-123',
    resource: MCP_RESOURCE,
    ...PKCE_PARAMS,
    ...overrides,
  }
}

function session(overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: REGISTERED_REDIRECT,
    clientState: 'client-state-123',
    clientId: CLIENT_ID,
    scope: 'openid profile email',
    needsPatientPicker: false,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('callback interception for proxy-issued resources', () => {
  test('intercepts a non-SMART request that targets the MCP resource', async () => {
    const store = new MemoryStore()
    const { result, sessionKey } = await handleAuthorize(mcpAuthorizeParams(), authorizeDeps(store))

    expect(result.type).toBe('redirect')
    expect(sessionKey).toBeDefined()
    if (result.type !== 'redirect') return

    const url = new URL(result.url)
    // The IdP must send the code to US, not to the client, or the response the
    // client sees carries the IdP's iss.
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE_URL}${CALLBACK_PATH}`)
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
      ...authorizeDeps(store),
      // Stands in for the resolver that fetches and validates the document.
      getRegisteredRedirectUris: async (id) => (id === CIMD_ID ? [REGISTERED_REDIRECT] : []),
    }

    const { result, sessionKey } = await handleAuthorize(
      mcpAuthorizeParams({ client_id: CIMD_ID }),
      deps,
    )

    expect(sessionKey).toBeDefined()
    if (result.type !== 'redirect') throw new Error('expected redirect')
    const url = new URL(result.url)
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE_URL}${CALLBACK_PATH}`)
    expect(url.searchParams.get('client_id')).toBe(CIMD_ID)
  })

  test('rejects a CIMD client whose document lists OTHER redirect_uris', async () => {
    const store = new MemoryStore()
    const deps: AuthorizeInterceptorDeps = {
      ...authorizeDeps(store),
      // Document fetched and valid, but the requested URI is not in it. A valid
      // document always has at least one entry (the resolver rejects empty ones),
      // so a NON-EMPTY list that excludes the request is the real "not allowed".
      getRegisteredRedirectUris: async () => ['https://somewhere-else.example.com/cb'],
    }

    const { result } = await handleAuthorize(
      mcpAuthorizeParams({ client_id: 'https://claude.ai/api/mcp/client-metadata.json' }),
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
      ...authorizeDeps(store),
      getRegisteredRedirectUris: async () => [],
    }

    const { result, sessionKey } = await handleAuthorize(
      mcpAuthorizeParams({ client_id: CIMD_ID }),
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
      mcpAuthorizeParams({ resource: 'https://other.example.com/api' }),
      authorizeDeps(store),
    )

    expect(sessionKey).toBeUndefined()
    if (result.type !== 'redirect') throw new Error('expected redirect')
    const url = new URL(result.url)
    expect(url.searchParams.get('redirect_uri')).toBe(REGISTERED_REDIRECT)
    expect(url.searchParams.get('state')).toBe('client-state-123')
  })

  test('does NOT intercept a plain OIDC login with no resource at all', async () => {
    const store = new MemoryStore()
    const params = mcpAuthorizeParams()
    delete params.resource
    const { result, sessionKey } = await handleAuthorize(params, authorizeDeps(store))

    expect(sessionKey).toBeUndefined()
    if (result.type !== 'redirect') throw new Error('expected redirect')
    expect(new URL(result.url).searchParams.get('redirect_uri')).toBe(REGISTERED_REDIRECT)
  })
})

describe('RFC 9207 — iss on every authorization response', () => {
  test('success redirect carries iss equal to the advertised issuer, verbatim', async () => {
    const store = new MemoryStore()
    store.set('sess-1', session())

    const { result } = await handleCallback({ state: 'sess-1', code: 'auth-code' }, callbackDeps(store))

    if (result.type !== 'redirect') throw new Error('expected redirect')
    const url = new URL(result.url)
    expect(url.searchParams.get('code')).toBe('auth-code')
    expect(url.searchParams.get('state')).toBe('client-state-123')
    // Simple string comparison, no normalization — not the IdP realm issuer, and
    // not a trailing-slash or case variant of our own base URL.
    expect(url.searchParams.get('iss')).toBe(BASE_URL)
  })

  test('error redirect carries iss too (RFC 9207 §2)', async () => {
    const store = new MemoryStore()
    store.set('sess-2', session())

    const { result } = await handleCallback(
      { state: 'sess-2', error: 'access_denied', error_description: 'User said no' },
      callbackDeps(store),
    )

    if (result.type !== 'redirect') throw new Error('expected redirect')
    const url = new URL(result.url)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('iss')).toBe(BASE_URL)
  })

  test('patient picker redirect carries iss', () => {
    const store = new MemoryStore()
    store.set('sess-3', session({ needsPatientPicker: true, pickerAllowed: true }))

    const result = handlePatientSelect(
      { session: 'sess-3', code: 'auth-code', patient: 'Patient/123' },
      callbackDeps(store),
    )

    if (result.type !== 'redirect') throw new Error('expected redirect')
    expect(new URL(result.url).searchParams.get('iss')).toBe(BASE_URL)
  })

  test('duplicate picker submission still carries iss', () => {
    const store = new MemoryStore()
    store.set('sess-4', session({ needsPatientPicker: false, patient: 'Patient/123' }))

    const result = handlePatientSelect(
      { session: 'sess-4', code: 'auth-code', patient: 'Patient/123' },
      callbackDeps(store),
    )

    if (result.type !== 'redirect') throw new Error('expected redirect')
    expect(new URL(result.url).searchParams.get('iss')).toBe(BASE_URL)
  })
})
