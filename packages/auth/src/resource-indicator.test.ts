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
import { handleAuthorize } from './authorize-interceptor'
import { getSessionAudience } from './token-enricher'
import { MemoryStore } from './stores/memory'
import {
  TEST_CLIENT_ID,
  TEST_REDIRECT_URI,
  makeAuthorizeDeps,
  makeAuthorizeParams,
  makeLaunchSession,
  testProxyConfig,
} from './test-fixtures'
import { hashAuthCode } from './auth-code'

const BASE_CONFIG = testProxyConfig({ callbackPath: '/auth/smart-callback' })
const AUTH_CODE = 'code-from-the-idp'
const FHIR_BASE = 'https://proxy.example.com/proxy-smart-backend/hapi-fhir-server/R4'

/** Every aud is valid here (validateAudience returns null). */
const AUTHORIZE = { config: BASE_CONFIG, redirectUris: [TEST_REDIRECT_URI], validateAudience: async () => null }
const SESSION = { needsPatientPicker: false, authCodeHash: hashAuthCode(AUTH_CODE) }

describe('RFC 8707 - authorize forwards validated aud as `resource`', () => {
  test('forwards resource=<aud> on the IdP redirect for a SMART session', async () => {
    const store = new MemoryStore()
    const deps = makeAuthorizeDeps(store, AUTHORIZE)

    const { result } = await handleAuthorize(
      makeAuthorizeParams({ aud: FHIR_BASE }),
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
    const deps = makeAuthorizeDeps(store, AUTHORIZE)

    const { result } = await handleAuthorize(makeAuthorizeParams({ scope: 'openid profile' }), deps)

    expect(result.type).toBe('redirect')
    if (result.type === 'redirect') {
      const url = new URL(result.url)
      expect(url.href.startsWith('https://kc.example.com')).toBe(true)
      expect(url.searchParams.get('resource')).toBeNull()
    }
  })

  test('does NOT forward an aud that carries a query string (guarded)', async () => {
    const store = new MemoryStore()
    const deps = makeAuthorizeDeps(store, AUTHORIZE)

    const { result } = await handleAuthorize(
      makeAuthorizeParams({ aud: 'https://ext.example.com/fhir?x=1' }),
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
    store.set('session-key', makeLaunchSession({ ...SESSION, aud: FHIR_BASE }))

    const aud = getSessionAudience(TEST_CLIENT_ID, TEST_REDIRECT_URI, AUTH_CODE, {
      config: BASE_CONFIG,
      store,
    })

    expect(aud).toBe(FHIR_BASE)
  })

  test('returns null when no session matches', () => {
    const store = new MemoryStore()
    store.set('session-key', makeLaunchSession({ ...SESSION, aud: FHIR_BASE }))

    const aud = getSessionAudience('other-client', TEST_REDIRECT_URI, AUTH_CODE, {
      config: BASE_CONFIG,
      store,
    })

    expect(aud).toBeNull()
  })

  test('returns null when the matching session carried no aud', () => {
    const store = new MemoryStore()
    store.set('session-key', makeLaunchSession(SESSION))

    const aud = getSessionAudience(TEST_CLIENT_ID, TEST_REDIRECT_URI, AUTH_CODE, {
      config: BASE_CONFIG,
      store,
    })

    expect(aud).toBeNull()
  })

  test('returns null when clientId or redirectUri is missing', () => {
    const store = new MemoryStore()
    store.set('session-key', makeLaunchSession({ ...SESSION, aud: FHIR_BASE }))

    expect(getSessionAudience(undefined, TEST_REDIRECT_URI, AUTH_CODE, { config: BASE_CONFIG, store })).toBeNull()
    expect(getSessionAudience(TEST_CLIENT_ID, undefined, AUTH_CODE, { config: BASE_CONFIG, store })).toBeNull()
  })

  test("returns null for an exchange carrying another sign-in's code", () => {
    const store = new MemoryStore()
    store.set('session-key', makeLaunchSession({ ...SESSION, aud: FHIR_BASE }))
    expect(getSessionAudience(TEST_CLIENT_ID, TEST_REDIRECT_URI, 'some-other-code', { config: BASE_CONFIG, store })).toBeNull()
    expect(getSessionAudience(TEST_CLIENT_ID, TEST_REDIRECT_URI, undefined, { config: BASE_CONFIG, store })).toBeNull()
  })
})
