/**
 * redirect-uri-validation.test.ts — TDD (security)
 *
 * VULN 1 (CRITICAL): Authorization-code theft via unvalidated redirect_uri.
 *
 * The SMART authorize interceptor stored the client's raw `redirect_uri` and
 * later forwarded the auth code to it without ever validating it against the
 * client's registered redirect URIs. Because the interceptor overwrites the
 * redirect_uri sent to Keycloak with the proxy's own callback, Keycloak never
 * validated the real client URI either — so there was zero redirect_uri
 * validation in the whole SMART path.
 *
 * Fix: inject `getRegisteredRedirectUris(clientId)` into the authorize handler
 * and the callback handler; validate `redirect_uri` by EXACT match (RFC 6749
 * §3.1.2) BEFORE storing/forwarding. Reject with an OAuth error otherwise.
 *
 * These tests assert SECURE behavior — they fail (red) on the pre-fix code.
 */

import { describe, test, expect } from 'bun:test'
import { handleAuthorize, type AuthorizeInterceptorDeps } from './authorize-interceptor'
import { handleCallback, type CallbackParams, type CallbackHandlerDeps } from './callback-handler'
import { isRedirectUriRegistered, resolvePostLogoutUri, resolveClientHomeUrl } from './redirect-uri'
import { MemoryStore } from './stores/memory'
import type { AuthorizeParams, LaunchSession, SmartProxyConfig } from './types'
import type { IdPAdapter } from './idp/interface'

const BASE_CONFIG: SmartProxyConfig = {
  baseUrl: 'https://proxy.example.com',
  callbackPath: '/auth/smart-callback',
  launchCodeSecret: 'test-secret-key-for-testing-only',
}

const REGISTERED_REDIRECT = 'https://app.example.com/callback'
const ATTACKER_REDIRECT = 'https://attacker.evil/steal'
const CLIENT_ID = 'smart-app-client'

const idp: IdPAdapter = {
  getAuthorizationUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/auth',
  getTokenUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/token',
  getIntrospectionUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/token/introspect',
  getLogoutUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/logout',
}

/** Build authorize deps with an injected registered-redirect-uri lookup. */
function makeAuthorizeDeps(
  store: MemoryStore,
  registered: string[],
): AuthorizeInterceptorDeps {
  return {
    config: BASE_CONFIG,
    store,
    idp,
    // The injected allowlist source the secure handler must consult.
    getRegisteredRedirectUris: async (clientId: string) =>
      clientId === CLIENT_ID ? registered : [],
  }
}

function smartAuthorizeParams(redirectUri: string): AuthorizeParams {
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid launch/patient patient/*.read',
    state: 'client-state-123',
  }
}

function makeSession(overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: REGISTERED_REDIRECT,
    clientState: 'client-state-123',
    clientId: CLIENT_ID,
    scope: 'openid launch/patient patient/*.read',
    needsPatientPicker: false,
    patient: 'Patient/123',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('VULN 1 — authorize: redirect_uri allowlist validation', () => {
  test('rejects an authorize request whose redirect_uri is NOT registered', async () => {
    const store = new MemoryStore()
    const deps = makeAuthorizeDeps(store, [REGISTERED_REDIRECT])

    const { result, sessionKey } = await handleAuthorize(
      smartAuthorizeParams(ATTACKER_REDIRECT),
      deps,
    )

    // SECURE: must error out, must NOT create a session, must NOT redirect to KC.
    expect(result.type).toBe('error')
    expect(result.type === 'error' && result.status).toBe(400)
    expect(result.type === 'error' && result.error).toBe('invalid_request')
    expect(sessionKey).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  test('does not leak a redirect to the attacker host', async () => {
    const store = new MemoryStore()
    const deps = makeAuthorizeDeps(store, [REGISTERED_REDIRECT])

    const { result } = await handleAuthorize(smartAuthorizeParams(ATTACKER_REDIRECT), deps)

    if (result.type === 'redirect') {
      expect(result.url).not.toContain('attacker.evil')
    }
    expect(result.type).toBe('error')
  })

  test('accepts a registered redirect_uri and proceeds normally (no regression)', async () => {
    const store = new MemoryStore()
    const deps = makeAuthorizeDeps(store, [REGISTERED_REDIRECT])

    const { result, sessionKey } = await handleAuthorize(
      smartAuthorizeParams(REGISTERED_REDIRECT),
      deps,
    )

    expect(result.type).toBe('redirect')
    expect(sessionKey).toBeDefined()
    const session = store.get(sessionKey!)
    expect(session).not.toBeNull()
    expect(session!.clientRedirectUri).toBe(REGISTERED_REDIRECT)

    // The redirect to KC must use the proxy callback (interception preserved).
    if (result.type === 'redirect') {
      const kcUrl = new URL(result.url)
      expect(kcUrl.searchParams.get('redirect_uri')).toBe(
        `${BASE_CONFIG.baseUrl}${BASE_CONFIG.callbackPath}`,
      )
    }
  })

  test('exact-match only: a registered-prefix attacker URI is rejected', async () => {
    const store = new MemoryStore()
    const deps = makeAuthorizeDeps(store, [REGISTERED_REDIRECT])

    // Open-redirect style: same prefix, different effective destination.
    const sneaky = `${REGISTERED_REDIRECT}.attacker.evil/cb`
    const { result } = await handleAuthorize(smartAuthorizeParams(sneaky), deps)

    expect(result.type).toBe('error')
    expect(store.size()).toBe(0)
  })

  test('when no validator is injected, behaviour is unchanged (backward compatible)', async () => {
    const store = new MemoryStore()
    const deps: AuthorizeInterceptorDeps = { config: BASE_CONFIG, store, idp }

    const { result, sessionKey } = await handleAuthorize(
      smartAuthorizeParams(REGISTERED_REDIRECT),
      deps,
    )

    // No validator → no allowlist enforcement (consumers opt in by injecting it).
    expect(result.type).toBe('redirect')
    expect(sessionKey).toBeDefined()
  })
})

describe('VULN 1 — callback: defense-in-depth redirect_uri re-validation', () => {
  test('rejects forwarding the auth code to an unregistered clientRedirectUri', async () => {
    const store = new MemoryStore()
    // A session that somehow carries an attacker redirect (e.g. pre-fix poisoning).
    store.set('session-key', makeSession({ clientRedirectUri: ATTACKER_REDIRECT }))

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      getRegisteredRedirectUris: async (clientId) =>
        clientId === CLIENT_ID ? [REGISTERED_REDIRECT] : [],
    }

    const params: CallbackParams = { state: 'session-key', code: 'auth-code-123' }
    const { result } = await handleCallback(params, deps)

    // SECURE: must NOT redirect the code to the attacker host.
    expect(result.type).toBe('error')
    if (result.type === 'redirect') {
      expect(result.url).not.toContain('attacker.evil')
    }
  })

  test('rejects forwarding an IdP error to an unregistered clientRedirectUri', async () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ clientRedirectUri: ATTACKER_REDIRECT }))

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      getRegisteredRedirectUris: async (clientId) =>
        clientId === CLIENT_ID ? [REGISTERED_REDIRECT] : [],
    }

    const params: CallbackParams = {
      state: 'session-key',
      error: 'access_denied',
      error_description: 'User denied',
    }
    const { result } = await handleCallback(params, deps)

    expect(result.type).toBe('error')
    if (result.type === 'redirect') {
      expect(result.url).not.toContain('attacker.evil')
    }
  })

  test('forwards the code normally when clientRedirectUri is registered', async () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ clientRedirectUri: REGISTERED_REDIRECT }))

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      getRegisteredRedirectUris: async (clientId) =>
        clientId === CLIENT_ID ? [REGISTERED_REDIRECT] : [],
    }

    const params: CallbackParams = { state: 'session-key', code: 'auth-code-123' }
    const { result } = await handleCallback(params, deps)

    expect(result.type).toBe('redirect')
    if (result.type === 'redirect') {
      expect(result.url).toContain('app.example.com/callback')
      expect(result.url).toContain('code=auth-code-123')
    }
  })
})

describe('isRedirectUriRegistered — Keycloak-compatible matching (exact + trailing wildcard)', () => {
  test('exact match', () => {
    expect(isRedirectUriRegistered('https://app.example.com/cb', ['https://app.example.com/cb'])).toBe(true)
  })

  test('trailing wildcard matches any path suffix (the dicom-viewer "/*" case)', () => {
    const reg = ['https://dicom.beta.maxhealth.tech/*']
    expect(isRedirectUriRegistered('https://dicom.beta.maxhealth.tech/callback', reg)).toBe(true)
    expect(isRedirectUriRegistered('https://dicom.beta.maxhealth.tech/cb?x=1', reg)).toBe(true)
    // Keycloak also matches the bare origin for a path wildcard.
    expect(isRedirectUriRegistered('https://dicom.beta.maxhealth.tech', reg)).toBe(true)
  })

  test('trailing wildcard does NOT cross the host boundary', () => {
    const reg = ['https://app.example.com/*']
    expect(isRedirectUriRegistered('https://app.example.com.evil/cb', reg)).toBe(false)
    expect(isRedirectUriRegistered('https://evil.com/https://app.example.com/', reg)).toBe(false)
  })

  test('a registration WITHOUT a wildcard stays strictly exact (no prefix bypass)', () => {
    const reg = ['https://app.example.com/cb']
    expect(isRedirectUriRegistered('https://app.example.com/cb.attacker.evil/x', reg)).toBe(false)
    expect(isRedirectUriRegistered('https://app.example.com/cb/extra', reg)).toBe(false)
  })

  test('empty allowlist rejects everything', () => {
    expect(isRedirectUriRegistered('https://app.example.com/cb', [])).toBe(false)
  })
})

describe('resolvePostLogoutUri', () => {
  const BASE = 'https://proxy.example.com'

  test('an unregistered requested URI is refused, not honoured', () => {
    // Otherwise /logout is an open redirect: ?post_logout_redirect_uri=https://evil.example
    expect(
      resolvePostLogoutUri({ baseUrl: BASE, requested: 'https://evil.example/', registered: ['https://app.example.com/*'] }),
    ).toBe('https://proxy.example.com/')
  })

  test('a registered requested URI is honoured', () => {
    expect(
      resolvePostLogoutUri({ baseUrl: BASE, requested: 'https://app.example.com/cb', registered: ['https://app.example.com/*'] }),
    ).toBe('https://app.example.com/cb')
  })

  test('a session URI wins, and only its origin is used', () => {
    expect(
      resolvePostLogoutUri({ baseUrl: BASE, sessionRedirectUri: 'https://app.example.com/callback?x=1' }),
    ).toBe('https://app.example.com')
  })

  test('the session URI is not overridden by a hostile request param', () => {
    expect(
      resolvePostLogoutUri({
        baseUrl: BASE,
        sessionRedirectUri: 'https://app.example.com/callback',
        requested: 'https://evil.example/',
      }),
    ).toBe('https://app.example.com')
  })

  test('nothing usable lands on the proxy, never undefined', () => {
    expect(resolvePostLogoutUri({ baseUrl: BASE })).toBe('https://proxy.example.com/')
    expect(resolvePostLogoutUri({ baseUrl: 'https://proxy.example.com/' })).toBe('https://proxy.example.com/')
  })

  test('a malformed session URI falls back rather than throwing', () => {
    expect(resolvePostLogoutUri({ baseUrl: BASE, sessionRedirectUri: 'not-a-url' })).toBe('https://proxy.example.com/')
  })
})

/**
 * The Home URL Keycloak's error page offers as "Back to application".
 *
 * No client-creation path ever set it, so `client.baseUrl` was empty for every client and the
 * theme's fallback — the proxy's own origin — took the link. A login that failed in the broker
 * offered the user Proxy Smart's front page instead of the app they came from.
 */
describe('resolveClientHomeUrl', () => {
  const PROXY = 'https://proxy.example.com'

  test('prefers the registered client_uri, which is the app home by definition', () => {
    expect(
      resolveClientHomeUrl({
        clientUri: 'https://app.example.com/welcome',
        redirectUris: ['https://other.example.com/cb'],
        proxyBaseUrl: PROXY,
      }),
    ).toBe('https://app.example.com/welcome')
  })

  test('falls back to a redirect origin, since the browser already goes there', () => {
    expect(
      resolveClientHomeUrl({ redirectUris: ['https://app.example.com/auth/cb'], proxyBaseUrl: PROXY }),
    ).toBe('https://app.example.com')
  })

  test('never answers with the proxy itself, which is the dead end being fixed', () => {
    expect(
      resolveClientHomeUrl({
        redirectUris: [`${PROXY}/auth/smart-callback`],
        proxyBaseUrl: PROXY,
      }),
    ).toBeUndefined()
  })

  test('skips the proxy callback to reach the app behind it', () => {
    expect(
      resolveClientHomeUrl({
        redirectUris: [`${PROXY}/auth/smart-callback`, 'https://app.example.com/cb'],
        proxyBaseUrl: PROXY,
      }),
    ).toBe('https://app.example.com')
  })

  test('a path wildcard still names the app origin it is anchored to', () => {
    expect(
      resolveClientHomeUrl({ redirectUris: ['https://app.example.com/*'], proxyBaseUrl: PROXY }),
    ).toBe('https://app.example.com')
  })

  test('a wildcard that is not a whole path segment names no destination', () => {
    expect(
      resolveClientHomeUrl({
        redirectUris: ['https://app.example.com*', 'https://*.example.com/*', 'https://app.example.com/cb*'],
        proxyBaseUrl: PROXY,
      }),
    ).toBeUndefined()
  })

  test('prefers the SMART launch URL over any redirect origin', () => {
    expect(
      resolveClientHomeUrl({
        launchUrl: 'https://app.example.com',
        redirectUris: ['https://other.example.com/cb'],
        proxyBaseUrl: PROXY,
      }),
    ).toBe('https://app.example.com/')
  })

  test('skips a proxy callback on a previous proxy host, which is not the app either', () => {
    expect(
      resolveClientHomeUrl({
        redirectUris: ['https://old-proxy.example.org/auth/smart-callback', 'https://app.example.com/*', `${PROXY}/auth/smart-callback`],
        proxyBaseUrl: PROXY,
      }),
    ).toBe('https://app.example.com')
  })

  test('rejects a non-http scheme, so a native client cannot put javascript: on the page', () => {
    expect(
      resolveClientHomeUrl({ clientUri: 'javascript:alert(1)', redirectUris: ['myapp://cb'] }),
    ).toBeUndefined()
  })

  test('undefined when there is nothing to offer, so no link beats a wrong one', () => {
    expect(resolveClientHomeUrl({})).toBeUndefined()
    expect(resolveClientHomeUrl({ clientUri: 'not-a-url', redirectUris: [] })).toBeUndefined()
  })
})
