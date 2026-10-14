// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART: granting a patient-restricted scope means the EHR SHALL establish a patient in context.
 * When that cannot happen the authorization is refused, back to the client per RFC 6749 §4.1.2.1.
 */
import { describe, test, expect } from 'bun:test'
import { handleCallback, handleIdentitySelect, handlePatientSelect, type CallbackHandlerDeps } from './callback-handler'
import { handleEncounterSelect } from './encounter-selection'
import { MemoryStore } from './stores/memory'
import type { IdentityCandidate } from './identity-choice'
import type { LaunchSession, SmartProxyConfig, SmartProxyResult } from './types'

const BASE_URL = 'https://proxy.example.com'
const CLIENT_REDIRECT = 'https://app.example.com/callback'
const CONFIG: SmartProxyConfig = { baseUrl: BASE_URL, launchCodeSecret: 'test-secret-key-for-testing-only' }
const SETUP_URL = 'https://portal.example.com/setup'

function session(overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: CLIENT_REDIRECT,
    clientState: 'state-7',
    clientId: 'app',
    scope: 'openid fhirUser launch/patient patient/*.rs',
    aud: `${BASE_URL}/proxy/hapi/R4`,
    needsPatientPicker: true,
    createdAt: Date.now(),
    ...overrides,
  }
}

function setup(overrides: Partial<LaunchSession>, extra: Partial<CallbackHandlerDeps> = {}) {
  const store = new MemoryStore()
  store.set('key', session(overrides))
  const deps: CallbackHandlerDeps = { config: CONFIG, store, autoResolvePatient: async () => null, ...extra }
  return { store, deps }
}

function clientError(result: SmartProxyResult): URL {
  if (result.type !== 'redirect') throw new Error(`expected a redirect, got ${JSON.stringify(result)}`)
  const url = new URL(result.url)
  expect(`${url.origin}${url.pathname}`).toBe(CLIENT_REDIRECT)
  expect(url.searchParams.get('state')).toBe('state-7')
  expect(url.searchParams.get('iss')).toBe(BASE_URL)
  expect(url.searchParams.has('code')).toBe(false)
  return url
}

function patientPicker(result: SmartProxyResult): URL {
  if (result.type !== 'redirect') throw new Error(`expected a redirect, got ${JSON.stringify(result)}`)
  const url = new URL(result.url)
  expect(url.pathname).toBe('/patient-picker/')
  expect(url.searchParams.get('choose')).toBeNull()
  return url
}

const callback = (deps: CallbackHandlerDeps) => handleCallback({ state: 'key', code: 'code-1' }, deps)

describe('the callback refuses a launch that cannot have a patient', () => {
  test('a non-practitioner identity gets access_denied on the client redirect, and the session ends', async () => {
    const { store, deps } = setup({ fhirUser: 'RelatedPerson/carer-9' })

    const { result } = await callback(deps)

    expect(clientError(result).searchParams.get('error')).toBe('access_denied')
    expect(store.get('key')).toBeNull()
  })

  test('an account linked to nothing is refused the same way, pointing at account setup when configured', async () => {
    const { deps } = setup({ fhirUser: undefined }, { accountSetupUrl: SETUP_URL })

    const { result } = await callback(deps)

    const url = clientError(result)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('error_uri')).toBe(SETUP_URL)
  })

  test('a Person whose links were read and name nothing usable is refused instead of deferred', async () => {
    const { deps } = setup({ fhirUser: 'Person/9' }, { resolveIdentities: async () => [] })

    const { result } = await callback(deps)

    expect(clientError(result).searchParams.get('error')).toBe('access_denied')
  })

  test('prompt=none cannot open the picker, so the client hears interaction_required', async () => {
    const { deps } = setup({ fhirUser: 'Practitioner/2', prompt: 'none' })

    const { result } = await callback(deps)

    expect(clientError(result).searchParams.get('error')).toBe('interaction_required')
  })
})

describe('a clinician reaches the patient picker however their identity was settled', () => {
  const PRACTITIONER: IdentityCandidate = { reference: 'Practitioner/2', resourceType: 'Practitioner' }
  const CARER: IdentityCandidate = { reference: 'RelatedPerson/3', resourceType: 'RelatedPerson' }

  test('a Person resolving to its one Practitioner is sent to the patient picker', async () => {
    const { store, deps } = setup({ fhirUser: 'Person/9' }, { resolveIdentities: async () => [PRACTITIONER] })

    const { result } = await callback(deps)

    patientPicker(result)
    expect(store.get('key')?.fhirUser).toBe('Practitioner/2')
    expect(store.get('key')?.pickerAllowed).toBe(true)
  })

  test('choosing a Practitioner identity in the identity picker continues to the patient picker', async () => {
    const { store, deps } = setup({ fhirUser: 'Person/9' }, { resolveIdentities: async () => [PRACTITIONER, CARER] })
    const first = await callback(deps)
    expect(first.result.type === 'redirect' && first.result.url).toContain('choose=identity')

    const result = handleIdentitySelect({ session: 'key', code: 'code-1', identity: 'Practitioner/2' }, deps)

    patientPicker(result)
    expect(store.get('key')?.pickerAllowed).toBe(true)
  })

  test('choosing a carer identity ends in access_denied, not a code without a patient', async () => {
    const { deps } = setup({ fhirUser: 'Person/9' }, { resolveIdentities: async () => [PRACTITIONER, CARER] })
    await callback(deps)

    const result = handleIdentitySelect({ session: 'key', code: 'code-1', identity: 'RelatedPerson/3' }, deps)

    expect(clientError(result).searchParams.get('error')).toBe('access_denied')
  })
})

describe('picker refusals go back to the client', () => {
  test('a patient submission for a session never cleared for the picker', () => {
    const { store, deps } = setup({ fhirUser: 'Patient/1' })

    const result = handlePatientSelect({ session: 'key', code: 'code-1', patient: 'someone-else' }, deps)

    expect(clientError(result).searchParams.get('error')).toBe('access_denied')
    expect(store.get('key')).toBeNull()
  })

  test('an identity the session never offered', () => {
    const { deps } = setup({ fhirUser: 'Person/9', needsIdentityPicker: true, identityOffered: ['Patient/1'] })

    const result = handleIdentitySelect({ session: 'key', code: 'code-1', identity: 'Practitioner/999' }, deps)

    expect(clientError(result).searchParams.get('error')).toBe('access_denied')
  })

  test('an encounter the picker never offered', () => {
    const { deps } = setup({ patient: 'p1', needsPatientPicker: false, needsEncounterPicker: true, encounterOffered: ['e1'] })

    const result = handleEncounterSelect({ session: 'key', code: 'code-1', encounter: 'e2' }, deps)

    expect(clientError(result).searchParams.get('error')).toBe('access_denied')
  })
})
