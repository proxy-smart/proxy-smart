/**
 * resource-indicator.test.ts - RFC 8707 resource-indicator audience binding.
 *
 * The SMART authorize interceptor now forwards the validated requested audience
 * to Keycloak as the RFC 8707 `resource` parameter (Keycloak 26.6.3 supports
 * RFC 8707 via the resource-indicators TokenPostProcessor). The raw `aud`
 * parameter is NOT forwarded (Keycloak does not consume it), and values that
 * carry a query or fragment are skipped because Keycloak's
 * ResourceIndicatorValidation rejects them.
 *
 * getSessionAudience resolves the audience captured for a SMART session at the
 * token endpoint so the proxy can re-send the same `resource` value (a mismatch
 * would make Keycloak return invalid_target / not-matching).
 */

import { describe, test, expect } from 'bun:test'
import { handleAuthorize, type AuthorizeInterceptorDeps } from './authorize-interceptor'
import { getSessionAudience } from './token-enricher'
import { MemoryStore } from './stores/memory'
import { hashAuthCode } from './auth-code'
import type { AuthorizeParams, LaunchSession, SmartProxyConfig } from './types'
import type { IdPAdapter } from './idp/interface'

const BASE_CONFIG: SmartProxyConfig = {
  baseUrl: 'https://proxy.example.com',
  callbackPath: '/auth/smart-callback',
  launchCodeSecret: 'test-secret-key-for-testing-only',
}

const REGISTERED_REDIRECT = 'https://app.example.com/callback'
const CLIENT_ID = 'smart-app-client'
const AUTH_CODE = 'code-from-the-idp'
const FHIR_BASE = 'https://proxy.example.com/proxy-smart-backend/hapi-fhir-server/R4'

const idp: IdPAdapter = {
  getAuthorizationUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/auth',
  getTokenUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/token',
  getIntrospectionUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/token/introspect',
  getLogoutUrl: () => 'https://kc.example.com/realms/test/protocol/openid-connect/logout',
}

/** Authorize deps that treat every aud as valid (validateAudience returns null). */
function makeAuthorizeDeps(store: MemoryStore): AuthorizeInterceptorDeps {
  return {
    config: BASE_CONFIG,
    store,
    idp,
    validateAudience: async () => null,
    getRegisteredRedirectUris: async (clientId: string) =>
      clientId === CLIENT_ID ? [REGISTERED_REDIRECT] : [],
  }
}

function smartAuthorizeParams(overrides: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REGISTERED_REDIRECT,
    scope: 'openid launch/patient patient/*.read',
    state: 'client-state-123',
    ...overrides,
  }
}

function makeSession(overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: REGISTERED_REDIRECT,
    clientState: 'client-state-123',
    clientId: CLIENT_ID,
    scope: 'openid launch/patient patient/*.read',
    needsPatientPicker: false,
    authCodeHash: hashAuthCode(AUTH_CODE),
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('RFC 8707 - authorize forwards validated aud as `resource`', () => {
  test('forwards resource=<aud> on the IdP redirect for a SMART session', async () => {
    const store = new MemoryStore()
    const deps = makeAuthorizeDeps(store)

    const { result } = await handleAuthorize(
      smartAuthorizeParams({ aud: FHIR_BASE }),
      deps,
    )

    expect(result.type).toBe('redirect')
    if (result.type === 'redirect') {
      const url = new URL(result.url)
      // The validated audience is forwarded as RFC 8707 `resource`.
      expect(url.searchParams.get('resource')).toBe(FHIR_BASE)
      // The raw `aud` parameter is NOT forwarded (Keycloak does not consume it).
      expect(url.searchParams.get('aud')).toBeNull()
    }
  })

  test('does NOT add a resource param when no aud is present', async () => {
    const store = new MemoryStore()
    const deps = makeAuthorizeDeps(store)

    const { result } = await handleAuthorize(smartAuthorizeParams(), deps)

    expect(result.type).toBe('redirect')
    if (result.type === 'redirect') {
      const url = new URL(result.url)
      expect(url.searchParams.get('resource')).toBeNull()
    }
  })

  test('does NOT forward an aud that carries a query string (guarded)', async () => {
    const store = new MemoryStore()
    const deps = makeAuthorizeDeps(store)

    const { result } = await handleAuthorize(
      smartAuthorizeParams({ aud: 'https://ext.example.com/fhir?x=1' }),
      deps,
    )

    expect(result.type).toBe('redirect')
    if (result.type === 'redirect') {
      const url = new URL(result.url)
      // Keycloak's ResourceIndicatorValidation rejects query/fragment, so the
      // interceptor must skip it even though validateAudience accepted it.
      expect(url.searchParams.get('resource')).toBeNull()
    }
  })
})

describe('getSessionAudience - resolve session aud at the token endpoint', () => {
  test('returns the aud captured for a matching SMART session', () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ aud: FHIR_BASE }))

    const aud = getSessionAudience(CLIENT_ID, REGISTERED_REDIRECT, AUTH_CODE, {
      config: BASE_CONFIG,
      store,
    })

    expect(aud).toBe(FHIR_BASE)
  })

  test('returns null when no session matches', () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ aud: FHIR_BASE }))

    const aud = getSessionAudience('other-client', REGISTERED_REDIRECT, AUTH_CODE, {
      config: BASE_CONFIG,
      store,
    })

    expect(aud).toBeNull()
  })

  test('returns null when the matching session carried no aud', () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession())

    const aud = getSessionAudience(CLIENT_ID, REGISTERED_REDIRECT, AUTH_CODE, {
      config: BASE_CONFIG,
      store,
    })

    expect(aud).toBeNull()
  })

  test('returns null when clientId or redirectUri is missing', () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ aud: FHIR_BASE }))

    expect(getSessionAudience(undefined, REGISTERED_REDIRECT, AUTH_CODE, { config: BASE_CONFIG, store })).toBeNull()
    expect(getSessionAudience(CLIENT_ID, undefined, AUTH_CODE, { config: BASE_CONFIG, store })).toBeNull()
  })

  test("returns null for an exchange carrying another sign-in's code", () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ aud: FHIR_BASE }))
    expect(getSessionAudience(CLIENT_ID, REGISTERED_REDIRECT, 'some-other-code', { config: BASE_CONFIG, store })).toBeNull()
    expect(getSessionAudience(CLIENT_ID, REGISTERED_REDIRECT, undefined, { config: BASE_CONFIG, store })).toBeNull()
  })
})
