/**
 * token-resource-indicator.test.ts
 *
 * Covers the RFC 8707 resource-injection branch of the /token endpoint via the
 * pure helper getSessionAudience. The token handler re-sends the resource that
 * was captured at /authorize so it matches what Keycloak stored on the code (a
 * mismatch would make Keycloak return invalid_target / not-matching).
 *
 * This is a pure-function test: no live Keycloak, no mock.module.
 */

import { describe, it, expect } from 'bun:test'
import { getSessionAudience, hashAuthCode, MemoryStore } from '@proxy-smart/auth'
import {
  TEST_CLIENT_ID,
  TEST_REDIRECT_URI,
  makeLaunchSession,
  testProxyConfig,
} from '@proxy-smart/auth/testing'

const CONFIG = testProxyConfig({ callbackPath: '/auth/smart-callback' })
const AUTH_CODE = 'code-from-the-idp'
const FHIR_BASE = 'https://proxy.example.com/proxy-smart-backend/hapi-fhir-server/R4'
const SESSION = { needsPatientPicker: false, authCodeHash: hashAuthCode(AUTH_CODE) }

describe('RFC 8707 - token endpoint resolves session aud', () => {
  it('returns the session.aud for a matching SMART session', () => {
    const store = new MemoryStore()
    store.set('session-key', makeLaunchSession({ ...SESSION, aud: FHIR_BASE }))

    const aud = getSessionAudience(TEST_CLIENT_ID, TEST_REDIRECT_URI, AUTH_CODE, { config: CONFIG, store })

    expect(aud).toBe(FHIR_BASE)
  })

  it('returns null when no SMART session matches', () => {
    const store = new MemoryStore()
    store.set('session-key', makeLaunchSession({ ...SESSION, aud: FHIR_BASE }))

    const aud = getSessionAudience('unknown-client', TEST_REDIRECT_URI, AUTH_CODE, { config: CONFIG, store })

    expect(aud).toBeNull()
  })
})
