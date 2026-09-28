// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * callback-handler.test.ts — TDD for patient-picker gate
 *
 * Bug: A Patient user (fhirUser = "Patient/X") should NEVER see the patient picker.
 * Even when autoResolvePatient fails (returns null), the callback handler should
 * fall back to the session's fhirUser attribute to auto-set the patient.
 */

import { describe, test, expect } from 'bun:test'
import { handleCallback, handlePatientSelect, type CallbackParams, type CallbackHandlerDeps } from './callback-handler'
import { MemoryStore } from './stores/memory'
import type { LaunchSession, SmartProxyConfig } from './types'

const BASE_CONFIG: SmartProxyConfig = {
  baseUrl: 'https://proxy.example.com',
  launchCodeSecret: 'test-secret-key-for-testing-only',
}

function makeSession(overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: 'https://app.example.com/callback',
    clientState: 'abc123',
    clientId: 'patient-portal',
    scope: 'openid fhirUser patient/*.rs launch/patient',
    needsPatientPicker: true,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('callback-handler: patient picker gate', () => {
  test('Patient user: skips picker when autoResolvePatient succeeds', async () => {
    const store = new MemoryStore()
    const session = makeSession({ needsPatientPicker: true })
    store.set('session-key', session)

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      autoResolvePatient: async () => 'max-nussbaumer',
    }

    const params: CallbackParams = { state: 'session-key', code: 'auth-code-123' }
    const { result } = await handleCallback(params, deps)

    // Should forward to client, NOT to picker
    expect(result.type).toBe('redirect')
    expect(result.type === 'redirect' && result.url).toContain('app.example.com/callback')
    expect(result.type === 'redirect' && result.url).not.toContain('patient-picker')

    // Session should have patient set
    const updated = store.get('session-key')
    expect(updated?.patient).toBe('max-nussbaumer')
    expect(updated?.needsPatientPicker).toBe(false)
  })

  test('Patient user: skips picker even when autoResolvePatient FAILS (returns null) — uses session fhirUser', async () => {
    const store = new MemoryStore()
    const session = makeSession({
      needsPatientPicker: true,
      fhirUser: 'Patient/max-nussbaumer', // This is populated from Keycloak protocol mapper
    })
    store.set('session-key', session)

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      // Simulates Keycloak admin API failure — returns null
      autoResolvePatient: async () => null,
    }

    const params: CallbackParams = { state: 'session-key', code: 'auth-code-123' }
    const { result } = await handleCallback(params, deps)

    // Should STILL forward to client, NOT show picker
    expect(result.type).toBe('redirect')
    expect(result.type === 'redirect' && result.url).toContain('app.example.com/callback')
    expect(result.type === 'redirect' && result.url).not.toContain('patient-picker')

    // Session should have patient auto-resolved from fhirUser
    const updated = store.get('session-key')
    expect(updated?.patient).toBe('max-nussbaumer')
    expect(updated?.needsPatientPicker).toBe(false)
  })

  test('Patient user: skips picker when NO autoResolvePatient hook provided — uses session fhirUser', async () => {
    const store = new MemoryStore()
    const session = makeSession({
      needsPatientPicker: true,
      fhirUser: 'Patient/max-nussbaumer',
    })
    store.set('session-key', session)

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      // No autoResolvePatient hook at all
    }

    const params: CallbackParams = { state: 'session-key', code: 'auth-code-123' }
    const { result } = await handleCallback(params, deps)

    // Should forward to client, NOT show picker
    expect(result.type).toBe('redirect')
    expect(result.type === 'redirect' && result.url).toContain('app.example.com/callback')
    expect(result.type === 'redirect' && result.url).not.toContain('patient-picker')

    const updated = store.get('session-key')
    expect(updated?.patient).toBe('max-nussbaumer')
    expect(updated?.needsPatientPicker).toBe(false)
  })

  test('Practitioner user: STILL shows picker when autoResolvePatient fails', async () => {
    const store = new MemoryStore()
    const session = makeSession({
      needsPatientPicker: true,
      fhirUser: 'Practitioner/example-practitioner',
    })
    store.set('session-key', session)

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      autoResolvePatient: async () => null,
    }

    const params: CallbackParams = { state: 'session-key', code: 'auth-code-123' }
    const { result } = await handleCallback(params, deps)

    // Practitioner SHOULD see the picker
    expect(result.type).toBe('redirect')
    expect(result.type === 'redirect' && result.url).toContain('patient-picker')
  })

  test('No fhirUser on session: REFUSES the picker rather than showing it', async () => {
    /*
     * This asserted the opposite until the picker was gated, and the old expectation was the hole:
     * the picker is a searchable directory of every Patient on the server, so an identity we cannot
     * place must not reach it. "No resolved patient" is not evidence of being a clinician.
     */
    const store = new MemoryStore()
    const session = makeSession({
      needsPatientPicker: true,
      // No fhirUser set
    })
    store.set('session-key', session)

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      autoResolvePatient: async () => null,
    }

    const params: CallbackParams = { state: 'session-key', code: 'auth-code-123' }
    const { result } = await handleCallback(params, deps)

    expect(result.type).toBe('error')
    expect(result.type === 'error' && result.status).toBe(403)
    expect(store.get('session-key')?.pickerAllowed).toBeUndefined()
  })

  test('Practitioner: the picker is cleared on the session, not merely redirected to', async () => {
    // `pickerAllowed` is what /auth/patient-search checks, so the gate must record its decision.
    const store = new MemoryStore()
    store.set('session-key', makeSession({ needsPatientPicker: true, fhirUser: 'Practitioner/dr-smith' }))

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      autoResolvePatient: async () => null,
    }

    const { result } = await handleCallback({ state: 'session-key', code: 'auth-code-123' }, deps)

    expect(result.type).toBe('redirect')
    expect(store.get('session-key')?.pickerAllowed).toBe(true)
  })
})

describe('callback-handler: Person fhirUser reaches the token endpoint', () => {
  /*
   * REGRESSION. SMART allows `fhirUser` to name a Person, and Max Health's IdP emits exactly
   * that (one Person per human, linking out to their Patient and/or Practitioner). The picker
   * gate could only place `Patient/*`, so every such user was refused with "Selecting a patient
   * requires a practitioner account" — a patient told to be a clinician. The token endpoint
   * resolves Person → Patient per client, so the launch has to be allowed to reach it.
   */
  test('Person: forwards to the client instead of refusing with 403', async () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ needsPatientPicker: true, fhirUser: 'Person/1007' }))

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      autoResolvePatient: async () => null,
    }

    const { result } = await handleCallback({ state: 'session-key', code: 'auth-code-123' }, deps)

    expect(result.type).toBe('redirect')
    expect(result.type === 'redirect' && result.url).toContain('app.example.com/callback')
    expect(result.type === 'redirect' && result.url).not.toContain('patient-picker')
  })

  test('Person: never gets picker access, since it resolves to its OWN patient downstream', async () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ needsPatientPicker: true, fhirUser: 'Person/1007' }))

    const deps: CallbackHandlerDeps = { config: BASE_CONFIG, store, autoResolvePatient: async () => null }
    await handleCallback({ state: 'session-key', code: 'auth-code-123' }, deps)

    // The directory stays practitioner-only; deferring must not hand out `pickerAllowed`.
    expect(store.get('session-key')?.pickerAllowed).toBeUndefined()
    expect(store.get('session-key')?.needsPatientPicker).toBe(false)
  })

  test('Person as an absolute reference is recognised too', async () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({
      needsPatientPicker: true,
      fhirUser: 'https://fhir.example.com/Person/1007',
    }))

    const deps: CallbackHandlerDeps = { config: BASE_CONFIG, store, autoResolvePatient: async () => null }
    const { result } = await handleCallback({ state: 'session-key', code: 'auth-code-123' }, deps)

    expect(result.type).toBe('redirect')
    expect(result.type === 'redirect' && result.url).not.toContain('patient-picker')
  })

  test('no fhirUser at all: refused as an unfinished sign-up, not as a missing practitioner role', async () => {
    /*
     * The account was never linked to a patient record, which the user can fix themselves.
     * `reason` is what the host renders off — asserting it, rather than the sentence, is what
     * keeps the copy free to improve.
     */
    const store = new MemoryStore()
    store.set('session-key', makeSession({ needsPatientPicker: true, fhirUser: undefined }))

    const deps: CallbackHandlerDeps = { config: BASE_CONFIG, store, autoResolvePatient: async () => null }
    const { result } = await handleCallback({ state: 'session-key', code: 'auth-code-123' }, deps)

    expect(result.type).toBe('error')
    expect(result.type === 'error' && result.reason).toBe('account-not-linked')
    // Still a refusal, and still no directory access.
    expect(result.type === 'error' && result.status).toBe(403)
    expect(store.get('session-key')?.pickerAllowed).toBeUndefined()
  })

  test('identity the host could not look up: deferred to the token endpoint, not refused as unlinked', async () => {
    const store = new MemoryStore()
    store.set('session-key', makeSession({ needsPatientPicker: true, fhirUser: undefined }))

    const deps: CallbackHandlerDeps = {
      config: BASE_CONFIG,
      store,
      autoResolvePatient: async (session) => {
        session.identityUnresolved = true
        return null
      },
    }
    const { result } = await handleCallback({ state: 'session-key', code: 'auth-code-123' }, deps)

    expect(result.type).toBe('redirect')
    expect(result.type === 'redirect' && result.url).toContain('app.example.com/callback')
    expect(store.get('session-key')?.pickerAllowed).toBeUndefined()
  })

  test('RelatedPerson is NOT a Person: still refused, because the token endpoint cannot place it', async () => {
    /*
     * Deferral covers exactly what `resolveFhirUserForClient` can resolve. Letting a
     * RelatedPerson through would issue a token carrying `launch/patient` and no patient,
     * which SMART forbids — the EHR SHALL establish a patient in context.
     */
    const store = new MemoryStore()
    store.set('session-key', makeSession({ needsPatientPicker: true, fhirUser: 'RelatedPerson/carer-9' }))

    const deps: CallbackHandlerDeps = { config: BASE_CONFIG, store, autoResolvePatient: async () => null }
    const { result } = await handleCallback({ state: 'session-key', code: 'auth-code-123' }, deps)

    expect(result.type).toBe('error')
    expect(result.type === 'error' && result.status).toBe(403)
    // An identity that exists but cannot be placed is the clinical route, not a sign-up gap.
    expect(result.type === 'error' && result.reason).toBe('not-a-practitioner')
  })

  test('a resolved patient still wins over deferral', async () => {
    // Deferral is the fallback for an unplaceable identity, not a bypass of real context.
    const store = new MemoryStore()
    store.set('session-key', makeSession({ needsPatientPicker: true, fhirUser: 'Person/1007' }))

    const deps: CallbackHandlerDeps = { config: BASE_CONFIG, store, autoResolvePatient: async () => '1008' }
    const { result } = await handleCallback({ state: 'session-key', code: 'auth-code-123' }, deps)

    expect(result.type).toBe('redirect')
    expect(store.get('session-key')?.patient).toBe('1008')
    expect(store.get('session-key')?.needsPatientPicker).toBe(false)
  })
})

describe('handlePatientSelect: duplicate submission guard', () => {
  test('returns redirect idempotently when patient already selected', () => {
    const store = new MemoryStore()
    const session = makeSession({
      needsPatientPicker: false,
      patient: 'test-patient-123',
    })
    store.set('session-key', session)

    const result = handlePatientSelect(
      { session: 'session-key', code: 'auth-code-456', patient: 'different-patient' },
      { config: BASE_CONFIG, store },
    )

    // Should redirect to client with original patient (not overwrite)
    expect(result.type).toBe('redirect')
    expect(result.type === 'redirect' && result.url).toContain('app.example.com/callback')
    expect(result.type === 'redirect' && result.url).toContain('code=auth-code-456')
    expect(result.type === 'redirect' && result.url).toContain('state=abc123')

    // Patient should remain unchanged
    const updated = store.get('session-key')
    expect(updated?.patient).toBe('test-patient-123')
  })

  test('allows selection when patient has not been chosen yet', () => {
    const store = new MemoryStore()
    const session = makeSession({ needsPatientPicker: true })
    store.set('session-key', session)

    const result = handlePatientSelect(
      { session: 'session-key', code: 'auth-code-789', patient: 'new-patient' },
      { config: BASE_CONFIG, store },
    )

    expect(result.type).toBe('redirect')
    expect(result.type === 'redirect' && result.url).toContain('app.example.com/callback')

    const updated = store.get('session-key')
    expect(updated?.patient).toBe('new-patient')
    expect(updated?.needsPatientPicker).toBe(false)
  })

  test('returns error for expired session', () => {
    const store = new MemoryStore()

    const result = handlePatientSelect(
      { session: 'nonexistent', code: 'auth-code', patient: 'patient-1' },
      { config: BASE_CONFIG, store },
    )

    expect(result.type).toBe('error')
    expect(result.type === 'error' && result.status).toBe(400)
  })
})
