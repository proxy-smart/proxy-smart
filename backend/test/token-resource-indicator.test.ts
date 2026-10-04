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
import type { LaunchSession, SmartProxyConfig } from '@proxy-smart/auth'

const CONFIG: SmartProxyConfig = {
  baseUrl: 'https://proxy.example.com',
  callbackPath: '/auth/smart-callback',
  launchCodeSecret: 'test-secret-key-for-testing-only',
}

const CLIENT_ID = 'smart-app-client'
const CLIENT_REDIRECT = 'https://app.example.com/callback'
const AUTH_CODE = 'code-from-the-idp'
const FHIR_BASE = 'https://proxy.example.com/proxy-smart-backend/hapi-fhir-server/R4'

function makeSession(overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: CLIENT_REDIRECT,
    clientState: 'client-state-123',
    clientId: CLIENT_ID,
    scope: 'openid launch/patient patient/*.read',
    needsPatientPicker: false,
    authCodeHash: hashAuthCode(AUTH_CODE),
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('RFC 8707 - token endpoint resolves session aud', () => {
  it('returns the session.aud for a matching SMART session', () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ aud: FHIR_BASE }))

    const aud = getSessionAudience(CLIENT_ID, CLIENT_REDIRECT, AUTH_CODE, { config: CONFIG, store })

    expect(aud).toBe(FHIR_BASE)
  })

  it('returns null when no SMART session matches', () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ aud: FHIR_BASE }))

    const aud = getSessionAudience('unknown-client', CLIENT_REDIRECT, AUTH_CODE, { config: CONFIG, store })

    expect(aud).toBeNull()
  })
})
