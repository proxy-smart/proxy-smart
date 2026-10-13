// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { handleCallback, handlePatientSelect, handleIdentitySelect, type CallbackHandlerDeps } from './callback-handler'
import { handleEncounterSelect, awaitsEncounterChoice, DEFAULT_ENCOUNTER_PICKER_PATH } from './encounter-selection'
import { handleAuthorize } from './authorize-interceptor'
import { isStandaloneEncounterLaunch, parseScopes } from './smart-scopes'
import { MemoryStore } from './stores/memory'
import { PKCE_PARAMS } from './test-fixtures'
import type { IdPAdapter } from './idp/interface'
import type { LaunchSession, SmartProxyConfig, SmartProxyResult } from './types'

const BASE_URL = 'https://proxy.example.com'
const AUD = `${BASE_URL}/proxy-smart-backend/hapi/R4`
const CONFIG: SmartProxyConfig = { baseUrl: BASE_URL, launchCodeSecret: 'test-secret-key-for-testing-only' }
const ENCOUNTER_SCOPES = 'openid fhirUser launch/patient launch/encounter patient/*.rs'

function makeSession(overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: 'https://app.example.com/callback',
    clientState: 'abc123',
    clientId: 'encounter-app',
    scope: ENCOUNTER_SCOPES,
    aud: AUD,
    createdAt: Date.now(),
    ...overrides,
  }
}

function deps(store: MemoryStore): CallbackHandlerDeps {
  return { config: CONFIG, store }
}

function redirectUrl(result: SmartProxyResult): URL {
  if (result.type !== 'redirect') throw new Error(`expected a redirect, got ${result.type}`)
  return new URL(result.url)
}

function expectEncounterPicker(result: SmartProxyResult, sessionKey: string, code: string): void {
  const url = redirectUrl(result)
  expect(url.pathname).toBe('/patient-picker/')
  expect(url.searchParams.get('choose')).toBe('encounter')
  expect(url.searchParams.get('session')).toBe(sessionKey)
  expect(url.searchParams.get('code')).toBe(code)
  expect(url.searchParams.get('aud')).toBe(AUD)
  expect(url.searchParams.get('iss')).toBeNull()
}

function expectClient(result: SmartProxyResult, code: string): void {
  const url = redirectUrl(result)
  expect(url.origin + url.pathname).toBe('https://app.example.com/callback')
  expect(url.searchParams.get('code')).toBe(code)
  expect(url.searchParams.get('state')).toBe('abc123')
  expect(url.searchParams.get('iss')).toBe(BASE_URL)
}

describe('isStandaloneEncounterLaunch', () => {
  test('is true for launch/encounter without a launch code', () => {
    expect(isStandaloneEncounterLaunch(parseScopes('openid launch/encounter'), false)).toBe(true)
  })

  test('is false when an EHR launch code supplies the context', () => {
    expect(isStandaloneEncounterLaunch(parseScopes('launch launch/encounter'), true)).toBe(false)
  })

  test('is false without launch/encounter, even for a bare launch scope', () => {
    expect(isStandaloneEncounterLaunch(parseScopes('openid launch launch/patient patient/*.rs'), false)).toBe(false)
  })
})

describe('awaitsEncounterChoice', () => {
  test('waits once a patient is known and no encounter is set', () => {
    expect(awaitsEncounterChoice(makeSession({ needsEncounterPicker: true, patient: 'p1' }))).toBe(true)
  })

  test('does not wait before a patient is known', () => {
    expect(awaitsEncounterChoice(makeSession({ needsEncounterPicker: true }))).toBe(false)
  })

  test('does not wait when an encounter is already in context', () => {
    expect(awaitsEncounterChoice(makeSession({ needsEncounterPicker: true, patient: 'p1', encounter: 'e1' }))).toBe(false)
  })

  test('never waits under prompt=none, which allows no interaction', () => {
    expect(awaitsEncounterChoice(makeSession({ needsEncounterPicker: true, patient: 'p1', prompt: 'none' }))).toBe(false)
  })
})

describe('handleAuthorize: standalone launch/encounter', () => {
  const idp: IdPAdapter = {
    getAuthorizationUrl: () => 'https://idp.example.com/auth',
    getTokenUrl: () => 'https://idp.example.com/token',
    getIntrospectionUrl: () => 'https://idp.example.com/introspect',
    getLogoutUrl: () => 'https://idp.example.com/logout',
  }

  async function authorize(scope: string): Promise<LaunchSession> {
    const store = new MemoryStore()
    const { sessionKey } = await handleAuthorize(
      { response_type: 'code', client_id: 'encounter-app', redirect_uri: 'https://app.example.com/callback', state: 's', scope, aud: AUD, ...PKCE_PARAMS },
      { config: CONFIG, store, idp },
    )
    const session = sessionKey ? store.get(sessionKey) : null
    if (!session) throw new Error('expected an intercepted session')
    return session
  }

  test('marks the session for encounter selection', async () => {
    expect((await authorize(ENCOUNTER_SCOPES)).needsEncounterPicker).toBe(true)
  })

  test('establishes a patient first even when only launch/encounter was asked for', async () => {
    expect((await authorize('openid fhirUser launch/encounter')).needsPatientPicker).toBe(true)
  })

  test('leaves a launch without launch/encounter alone', async () => {
    expect((await authorize('openid fhirUser launch/patient patient/*.rs')).needsEncounterPicker).toBe(false)
  })
})

describe('handleCallback: encounter step', () => {
  test('a patient user is sent to the encounter picker once the patient resolves', async () => {
    const store = new MemoryStore()
    store.set('k1', makeSession({ needsPatientPicker: true, needsEncounterPicker: true, fhirUser: 'Patient/p1' }))

    const { result } = await handleCallback({ state: 'k1', code: 'c1' }, deps(store))

    expectEncounterPicker(result, 'k1', 'c1')
    expect(store.get('k1')?.patient).toBe('p1')
  })

  test('an EHR-supplied encounter skips the picker', async () => {
    const store = new MemoryStore()
    store.set('k2', makeSession({ needsEncounterPicker: true, patient: 'p1', encounter: 'e1' }))

    const { result } = await handleCallback({ state: 'k2', code: 'c2' }, deps(store))

    expectClient(result, 'c2')
  })

  test('prompt=none forwards without asking', async () => {
    const store = new MemoryStore()
    store.set('k3', makeSession({ needsEncounterPicker: true, patient: 'p1', prompt: 'none' }))

    const { result } = await handleCallback({ state: 'k3', code: 'c3' }, deps(store))

    expectClient(result, 'c3')
  })
})

describe('handlePatientSelect: hands over to the encounter step', () => {
  test('a chosen patient leads to the encounter picker when launch/encounter was asked for', () => {
    const store = new MemoryStore()
    store.set('k4', makeSession({ needsPatientPicker: true, pickerAllowed: true, needsEncounterPicker: true }))

    const result = handlePatientSelect({ session: 'k4', code: 'c4', patient: 'p9' }, deps(store))

    expectEncounterPicker(result, 'k4', 'c4')
    expect(store.get('k4')?.patient).toBe('p9')
  })

  test('a repeated submission returns to the encounter picker while it is still pending', () => {
    const store = new MemoryStore()
    store.set('k5', makeSession({ needsPatientPicker: false, patient: 'p9', needsEncounterPicker: true }))

    const result = handlePatientSelect({ session: 'k5', code: 'c5', patient: 'p9' }, deps(store))

    expectEncounterPicker(result, 'k5', 'c5')
  })

  test('a session the practitioner gate never cleared cannot set a patient', () => {
    const store = new MemoryStore()
    store.set('k6', makeSession({ needsPatientPicker: true }))

    const result = handlePatientSelect({ session: 'k6', code: 'c6', patient: 'someone-else' }, deps(store))

    expect(redirectUrl(result).searchParams.get('error')).toBe('access_denied')
    expect(store.get('k6')).toBeNull()
  })
})

describe('handleIdentitySelect: hands over to the encounter step', () => {
  test('choosing the patient identity leads to the encounter picker', () => {
    const store = new MemoryStore()
    store.set('k7', makeSession({
      needsIdentityPicker: true,
      identityOffered: ['Patient/p1', 'Practitioner/d1'],
      needsEncounterPicker: true,
    }))

    const result = handleIdentitySelect({ session: 'k7', code: 'c7', identity: 'Patient/p1' }, deps(store))

    expectEncounterPicker(result, 'k7', 'c7')
  })
})

describe('handleEncounterSelect', () => {
  function pending(overrides: Partial<LaunchSession> = {}): MemoryStore {
    const store = new MemoryStore()
    store.set('k', makeSession({ needsEncounterPicker: true, patient: 'p1', encounterOffered: ['e1', 'e2'], ...overrides }))
    return store
  }

  test('binds an offered encounter and forwards the code', () => {
    const store = pending()

    const result = handleEncounterSelect({ session: 'k', code: 'c', encounter: 'e2' }, deps(store))

    expectClient(result, 'c')
    const session = store.get('k')
    expect(session?.encounter).toBe('e2')
    expect(session?.needsEncounterPicker).toBe(false)
    expect(session?.encounterOffered).toBeUndefined()
  })

  test('accepts a typed reference to an offered encounter', () => {
    const store = pending()

    handleEncounterSelect({ session: 'k', code: 'c', encounter: 'Encounter/e1' }, deps(store))

    expect(store.get('k')?.encounter).toBe('e1')
  })

  test('refuses an encounter that was not offered for this patient', () => {
    const store = pending()

    const result = handleEncounterSelect({ session: 'k', code: 'c', encounter: 'someone-elses' }, deps(store))

    expect(redirectUrl(result).searchParams.get('error')).toBe('access_denied')
    expect(redirectUrl(result).searchParams.has('code')).toBe(false)
    expect(store.get('k')).toBeNull()
  })

  test('proceeds without an encounter when none could be offered', () => {
    const store = pending({ encounterOffered: [] })

    const result = handleEncounterSelect({ session: 'k', code: 'c' }, deps(store))

    expectClient(result, 'c')
    expect(store.get('k')?.encounter).toBeUndefined()
    expect(store.get('k')?.needsEncounterPicker).toBe(false)
  })

  test('requires a choice when encounters were offered', () => {
    const store = pending()

    const result = handleEncounterSelect({ session: 'k', code: 'c' }, deps(store))

    expect(result.type === 'error' && result.status).toBe(400)
    expect(store.get('k')?.needsEncounterPicker).toBe(true)
  })

  test('refuses before a patient is in context', () => {
    const store = pending({ patient: undefined })

    const result = handleEncounterSelect({ session: 'k', code: 'c', encounter: 'e1' }, deps(store))

    expect(result.type === 'error' && result.status).toBe(400)
  })

  test('repeats the client redirect after the choice was made', () => {
    const store = pending({ needsEncounterPicker: false, encounter: 'e1', encounterOffered: undefined })

    const result = handleEncounterSelect({ session: 'k', code: 'c', encounter: 'e2' }, deps(store))

    expectClient(result, 'c')
    expect(store.get('k')?.encounter).toBe('e1')
  })

  test('rejects a missing session or code', () => {
    const store = pending()
    expect(handleEncounterSelect({ code: 'c', encounter: 'e1' }, deps(store)).type).toBe('error')
    expect(handleEncounterSelect({ session: 'k', encounter: 'e1' }, deps(store)).type).toBe('error')
  })

  test('rejects an expired session', () => {
    const result = handleEncounterSelect({ session: 'gone', code: 'c', encounter: 'e1' }, deps(new MemoryStore()))
    expect(result.type === 'error' && result.status).toBe(400)
  })

  test('the default picker path is the patient picker bundle in encounter mode', () => {
    expect(DEFAULT_ENCOUNTER_PICKER_PATH).toBe('/patient-picker/?choose=encounter')
  })
})
