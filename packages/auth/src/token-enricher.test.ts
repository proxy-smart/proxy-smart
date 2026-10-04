// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { enrichTokenResponse } from './token-enricher'
import { MemoryStore } from './stores/memory'
import { hashAuthCode } from './auth-code'
import type { LaunchSession, SmartProxyConfig } from './types'

const config: SmartProxyConfig = { baseUrl: 'https://proxy.example.com', launchCodeSecret: 'test-secret-key-for-testing-only' }
const CLIENT_ID = 'viewer'
const REDIRECT = 'https://viewer.example.com/callback'
const SCOPE = 'openid fhirUser launch patient/ImagingStudy.rs'

function session(code: string, overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: REDIRECT,
    clientState: 's',
    clientId: CLIENT_ID,
    scope: SCOPE,
    patient: 'Patient/1005',
    authCodeHash: hashAuthCode(code),
    createdAt: Date.now(),
    ...overrides,
  }
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
