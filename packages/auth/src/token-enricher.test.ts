// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { enrichTokenResponse, verifyCodeRedemption } from './token-enricher'
import { MemoryStore } from './stores/memory'
import { hashAuthCode } from './auth-code'
import { makeLaunchSession, testProxyConfig } from './test-fixtures'
import type { LaunchSession } from './types'

const config = testProxyConfig()
const CLIENT_ID = 'viewer'
const REDIRECT = 'https://viewer.example.com/callback'
const SCOPE = 'openid fhirUser launch patient/ImagingStudy.rs'

function session(code: string, overrides: Partial<LaunchSession> = {}): LaunchSession {
  return makeLaunchSession({
    clientRedirectUri: REDIRECT,
    clientState: 's',
    clientId: CLIENT_ID,
    scope: SCOPE,
    patient: 'Patient/1005',
    authCodeHash: hashAuthCode(code),
    ...overrides,
  })
}

function enrich(store: MemoryStore, code: string | undefined, sub = 'user-a') {
  return enrichTokenResponse(
    { tokenPayload: { sub }, clientId: CLIENT_ID, redirectUri: REDIRECT, code, grantedScope: SCOPE },
    { config, store },
  )
}

describe('launch context in the token response', () => {
  test('comes from the session that forwarded this exchange\'s code', () => {
    const store = new MemoryStore()
    store.set('k', session('code-a'))
    expect(enrich(store, 'code-a').patient).toBe('1005')
  })

  test('is never taken from another sign-in\'s session for the same client and redirect URI', () => {
    const store = new MemoryStore()
    store.set('k', session('code-a'))
    expect(enrich(store, 'code-b', 'user-b').patient).toBeUndefined()
    expect(enrich(store, undefined, 'user-b').patient).toBeUndefined()
    expect(store.get('k')).not.toBeNull()
  })

  test('from a launch code applies only to the user it was issued to', () => {
    const issued = new MemoryStore()
    issued.set('k', session('code-a', { launchSub: 'user-a' }))
    expect(enrich(issued, 'code-a', 'user-a').patient).toBe('1005')

    const forwarded = new MemoryStore()
    forwarded.set('k', session('code-a', { launchSub: 'user-a' }))
    expect(enrich(forwarded, 'code-a', 'user-b').patient).toBeUndefined()
  })
})

describe('appContext in the token response', () => {
  test('is returned exactly as the launch carried it', () => {
    const store = new MemoryStore()
    const appContext = '{"field1":"value"}'
    store.set('k', session('code-a', { appContext }))
    expect(enrich(store, 'code-a').appContext).toBe(appContext)
  })

  test('is absent when the launch carried none', () => {
    const store = new MemoryStore()
    store.set('k', session('code-a'))
    expect(enrich(store, 'code-a').appContext).toBeUndefined()
  })
})

describe('redeeming an authorization code', () => {
  const deps = (store: MemoryStore) => ({ config, store })

  test('refuses the proxy callback as redirect_uri, which would skip the comparison with the app\'s own', () => {
    const result = verifyCodeRedemption(
      { clientId: CLIENT_ID, redirectUri: 'https://proxy.example.com/auth/smart-callback', code: 'any' },
      deps(new MemoryStore()),
    )
    expect(result).toEqual({ ok: false, error: 'invalid_grant', description: expect.any(String) })
  })

  test('refuses the proxy callback however it is spelled', () => {
    const spellings = [
      'https://PROXY.example.com/auth/smart-callback',
      'https://proxy.example.com/auth/smart-callback/',
      'https://proxy.example.com:443/auth/smart-callback?x=1',
    ]
    for (const redirectUri of spellings) {
      expect(verifyCodeRedemption({ clientId: CLIENT_ID, redirectUri, code: 'c' }, deps(new MemoryStore())).ok).toBe(false)
    }
  })

  test('refuses an intercepted code redeemed with another redirect_uri or by another client', () => {
    const store = new MemoryStore()
    store.set('k', session('code-a'))
    expect(verifyCodeRedemption({ clientId: CLIENT_ID, redirectUri: 'https://evil.example.com/cb', code: 'code-a' }, deps(store)).ok).toBe(false)
    expect(verifyCodeRedemption({ clientId: 'other-app', redirectUri: REDIRECT, code: 'code-a' }, deps(store)).ok).toBe(false)
    expect(verifyCodeRedemption({ clientId: CLIENT_ID, redirectUri: undefined, code: 'code-a' }, deps(store)).ok).toBe(false)
  })

  test('accepts an intercepted code redeemed as it was issued', () => {
    const store = new MemoryStore()
    store.set('k', session('code-a'))
    expect(verifyCodeRedemption({ clientId: CLIENT_ID, redirectUri: REDIRECT, code: 'code-a' }, deps(store))).toEqual({ ok: true })
  })

  test('leaves a code the proxy never saw to the IdP', () => {
    expect(verifyCodeRedemption({ clientId: CLIENT_ID, redirectUri: REDIRECT, code: 'unknown' }, deps(new MemoryStore()))).toEqual({ ok: true })
  })
})

describe('scope in the token response', () => {
  test('is never widened by a smart_scope claim', () => {
    const enrichment = enrichTokenResponse(
      { tokenPayload: { sub: 'u', smart_scope: 'patient/*.cruds system/*.*' }, clientId: CLIENT_ID, grantedScope: 'patient/*.rs' },
      { config, store: new MemoryStore() },
    )
    expect(Object.keys(enrichment)).not.toContain('scope')
  })
})
