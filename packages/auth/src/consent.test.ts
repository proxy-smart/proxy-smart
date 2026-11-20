// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { handleCallback, type CallbackHandlerDeps } from './callback-handler'
import { handleConsentDecision, type ConsentDecisionDeps } from './consent'
import { handleEncounterSelect } from './encounter-selection'
import { MemoryStore } from './stores/memory'
import { errorRedirectOf, makeCallbackDeps, makeLaunchSession, redirectOf, TEST_BASE_URL, TEST_REDIRECT_URI } from './test-fixtures'
import type { LaunchSession } from './types'

const KEY = 'session-key'
const CODE = 'idp-code'
const RESOURCE = 'https://imaging.example.com/mcp'

function started(overrides: Partial<LaunchSession> = {}): MemoryStore {
  const store = new MemoryStore()
  store.set(KEY, makeLaunchSession({ aud: RESOURCE, ...overrides }))
  return store
}

const callback = (store: MemoryStore, overrides: Partial<CallbackHandlerDeps> = {}) =>
  handleCallback({ state: KEY, code: CODE, session_state: 'kc-session' }, makeCallbackDeps(store, overrides))

const decide = (store: MemoryStore, decision: string, overrides: Partial<ConsentDecisionDeps> = {}) =>
  handleConsentDecision({ session: KEY, code: CODE, decision }, { ...makeCallbackDeps(store), ...overrides })

describe('consent the proxy asks for after sign-in', () => {
  test('holds the code at the consent page while the user has not approved', async () => {
    const store = started()
    const { result } = await callback(store, { consentPending: async () => ({ userId: 'user-1' }) })

    const url = redirectOf(result)
    expect(`${url.origin}${url.pathname}`).toBe(`${TEST_BASE_URL}/auth/consent`)
    expect(url.searchParams.get('session')).toBe(KEY)
    expect(url.searchParams.get('aud')).toBe(RESOURCE)
    expect(store.get(KEY)).toMatchObject({ needsConsent: true, consentUserId: 'user-1' })
  })

  test('releases the code to the client when an earlier approval covers the request', async () => {
    const store = started()
    const { result } = await callback(store, { consentPending: async () => null })

    expect(redirectOf(result).href.startsWith(TEST_REDIRECT_URI)).toBe(true)
    expect(store.get(KEY)?.needsConsent).toBeUndefined()
  })

  test('asks, and remembers nothing, when earlier consent cannot be read', async () => {
    const store = started()
    const { result } = await callback(store, { consentPending: async () => { throw new Error('database down') } })

    expect(redirectOf(result).pathname).toBe('/auth/consent')
    expect(store.get(KEY)?.consentUserId).toBeUndefined()
  })

  test('answers consent_required to prompt=none, which cannot show a page', async () => {
    const store = started({ prompt: 'none' })
    const { result } = await callback(store, { consentPending: async () => ({ userId: 'user-1' }) })

    expect(errorRedirectOf(result).error).toBe('consent_required')
  })

  test('stops at the consent page after an encounter is chosen, too', () => {
    const store = started({ patient: 'p1', needsEncounterPicker: true, encounterOffered: ['e1'], needsConsent: true })
    const result = handleEncounterSelect({ session: KEY, code: CODE, encounter: 'e1' }, makeCallbackDeps(store))
    expect(redirectOf(result).pathname).toBe('/auth/consent')
  })
})

describe('the consent decision', () => {
  test('remembers an approval for the user, then releases the code', async () => {
    const store = started({ needsConsent: true, consentUserId: 'user-1' })
    const remembered: LaunchSession[] = []

    const result = await decide(store, 'approve', { recordConsent: async (session) => { remembered.push(session) } })

    expect(redirectOf(result).href.startsWith(TEST_REDIRECT_URI)).toBe(true)
    expect(remembered.map((session) => [session.consentUserId, session.aud])).toEqual([['user-1', RESOURCE]])
    expect(store.get(KEY)?.needsConsent).toBe(false)
  })

  test('still releases the code when the approval cannot be remembered', async () => {
    const store = started({ needsConsent: true, consentUserId: 'user-1' })
    const result = await decide(store, 'approve', { recordConsent: async () => { throw new Error('database down') } })
    expect(redirectOf(result).href.startsWith(TEST_REDIRECT_URI)).toBe(true)
  })

  test('approves without remembering when the user was never identified', async () => {
    const store = started({ needsConsent: true })
    let calls = 0
    const result = await decide(store, 'approve', { recordConsent: async () => { calls += 1 } })
    expect(redirectOf(result).href.startsWith(TEST_REDIRECT_URI)).toBe(true)
    expect(calls).toBe(0)
  })

  test('sends access_denied to the client when the user declines', async () => {
    const store = started({ needsConsent: true, consentUserId: 'user-1' })
    const result = await decide(store, 'deny')

    expect(errorRedirectOf(result).error).toBe('access_denied')
    expect(store.get(KEY)).toBeNull()
  })

  test('repeats the redirect on a second submit instead of asking again', async () => {
    const store = started({ needsConsent: false })
    const result = await decide(store, 'approve')
    expect(redirectOf(result).href.startsWith(TEST_REDIRECT_URI)).toBe(true)
  })

  test('refuses a submission without a decision', async () => {
    const store = started({ needsConsent: true })
    const result = await decide(store, 'maybe')
    expect(result.type === 'error' && result.error).toBe('invalid_request')
  })
})
