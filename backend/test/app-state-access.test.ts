// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import {
  authorizeAppState,
  callerFromToken,
  type AppStateCaller,
  type AppStateRegistration,
} from '../src/lib/app-state/access'
import { tokenContextStore } from '../src/lib/token-context-store'

const BASE = 'https://proxy.example.org/proxy-smart-backend/hapi/R4'
const CODE = 'https://app.example.org|prefs'
const OTHER_CODE = 'https://app.example.org|keys'

function caller(overrides: Partial<AppStateCaller> = {}): AppStateCaller {
  return {
    clientId: 'demo-app',
    scopes: new Set(['patient/Basic.cuds', 'user/Basic.cuds']),
    patient: 'Patient/a',
    users: ['Practitioner/b'],
    ...overrides,
  }
}

const registered: AppStateRegistration = { codes: new Set([CODE]), globalCodes: new Set() }

describe('authorizeAppState: state codes are tied to the app registration', () => {
  it('allows a registered code on the in-context patient', () => {
    expect(authorizeAppState({ caller: caller(), registration: registered, interaction: 'create', stateCode: CODE, subject: `${BASE}/Patient/a` }).allowed).toBe(true)
  })

  it('refuses a code the app is not registered for, whatever its scopes', () => {
    const result = authorizeAppState({ caller: caller(), registration: registered, interaction: 'search', stateCode: OTHER_CODE, subject: `${BASE}/Patient/a` })
    expect(result.allowed).toBe(false)
  })

  it('treats a global-write code as registered for queries too', () => {
    const registration = { codes: new Set<string>(), globalCodes: new Set([CODE]) }
    expect(authorizeAppState({ caller: caller(), registration, interaction: 'search', stateCode: CODE, subject: `${BASE}/Patient/a` }).allowed).toBe(true)
  })
})

describe('authorizeAppState: subject must be the in-context patient or the user', () => {
  it('refuses another patient', () => {
    const result = authorizeAppState({ caller: caller(), registration: registered, interaction: 'search', stateCode: CODE, subject: `${BASE}/Patient/z` })
    expect(result.allowed).toBe(false)
  })

  it('allows the in-context user with a user-level scope', () => {
    const c = caller({ scopes: new Set(['user/Basic.cuds']) })
    expect(authorizeAppState({ caller: c, registration: registered, interaction: 'update', stateCode: CODE, subject: `${BASE}/Practitioner/b` }).allowed).toBe(true)
  })

  it('does not let a patient-level scope reach user state', () => {
    const c = caller({ scopes: new Set(['patient/Basic.cuds']) })
    expect(authorizeAppState({ caller: c, registration: registered, interaction: 'search', stateCode: CODE, subject: `${BASE}/Practitioner/b` }).allowed).toBe(false)
  })

  it('lets a user-level scope write patient state on behalf of the user', () => {
    const c = caller({ scopes: new Set(['user/Basic.cuds']) })
    expect(authorizeAppState({ caller: c, registration: registered, interaction: 'create', stateCode: CODE, subject: `${BASE}/Patient/a` }).allowed).toBe(true)
  })

  it('accepts PractitionerRole as the user', () => {
    const c = caller({ users: ['PractitionerRole/r1'], scopes: new Set(['user/Basic.s']) })
    expect(authorizeAppState({ caller: c, registration: registered, interaction: 'search', stateCode: CODE, subject: `${BASE}/PractitionerRole/r1` }).allowed).toBe(true)
  })

  it('refuses a patient subject when the token has no patient context', () => {
    const c = caller({ patient: null, users: [] })
    expect(authorizeAppState({ caller: c, registration: registered, interaction: 'search', stateCode: CODE, subject: `${BASE}/Patient/a` }).allowed).toBe(false)
  })
})

describe('authorizeAppState: scopes', () => {
  it('maps interactions onto SMART v2 permission characters', () => {
    const readOnly = caller({ scopes: new Set(['patient/Basic.s']) })
    const subject = `${BASE}/Patient/a`
    expect(authorizeAppState({ caller: readOnly, registration: registered, interaction: 'search', stateCode: CODE, subject }).allowed).toBe(true)
    expect(authorizeAppState({ caller: readOnly, registration: registered, interaction: 'create', stateCode: CODE, subject }).allowed).toBe(false)
    expect(authorizeAppState({ caller: readOnly, registration: registered, interaction: 'update', stateCode: CODE, subject }).allowed).toBe(false)
    expect(authorizeAppState({ caller: readOnly, registration: registered, interaction: 'delete', stateCode: CODE, subject }).allowed).toBe(false)
  })

  it('honours a code-narrowed scope', () => {
    const narrowed = caller({ scopes: new Set([`patient/Basic.cuds?code=${CODE}`]) })
    const registration = { codes: new Set([CODE, OTHER_CODE]), globalCodes: new Set<string>() }
    const subject = `${BASE}/Patient/a`
    expect(authorizeAppState({ caller: narrowed, registration, interaction: 'create', stateCode: CODE, subject }).allowed).toBe(true)
    expect(authorizeAppState({ caller: narrowed, registration, interaction: 'create', stateCode: OTHER_CODE, subject }).allowed).toBe(false)
  })

  it('does not treat a scope narrowed by an unknown parameter as unrestricted', () => {
    const odd = caller({ scopes: new Set(['patient/Basic.cuds?category=x']) })
    expect(authorizeAppState({ caller: odd, registration: registered, interaction: 'search', stateCode: CODE, subject: `${BASE}/Patient/a` }).allowed).toBe(false)
  })

  it('accepts resource wildcards and SMART v1 read/write', () => {
    const subject = `${BASE}/Patient/a`
    const wildcard = caller({ scopes: new Set(['patient/*.cruds']) })
    expect(authorizeAppState({ caller: wildcard, registration: registered, interaction: 'delete', stateCode: CODE, subject }).allowed).toBe(true)
    const v1 = caller({ scopes: new Set(['patient/Basic.read']) })
    expect(authorizeAppState({ caller: v1, registration: registered, interaction: 'search', stateCode: CODE, subject }).allowed).toBe(true)
    expect(authorizeAppState({ caller: v1, registration: registered, interaction: 'create', stateCode: CODE, subject }).allowed).toBe(false)
  })

  it('ignores scopes for other resource types', () => {
    const c = caller({ scopes: new Set(['patient/Observation.cruds']) })
    expect(authorizeAppState({ caller: c, registration: registered, interaction: 'search', stateCode: CODE, subject: `${BASE}/Patient/a` }).allowed).toBe(false)
  })
})

describe('authorizeAppState: global app state', () => {
  it('queries global state with user/Basic.s', () => {
    const c = caller({ scopes: new Set(['user/Basic.s']) })
    expect(authorizeAppState({ caller: c, registration: registered, interaction: 'search', stateCode: CODE, subject: null }).allowed).toBe(true)
  })

  it('does not let a patient-level scope query global state', () => {
    const c = caller({ scopes: new Set(['patient/Basic.cuds']) })
    expect(authorizeAppState({ caller: c, registration: registered, interaction: 'search', stateCode: CODE, subject: null }).allowed).toBe(false)
  })

  it('keeps global writes for apps registered as administrative for that code', () => {
    const c = caller({ scopes: new Set(['user/Basic.cuds']) })
    expect(authorizeAppState({ caller: c, registration: registered, interaction: 'create', stateCode: CODE, subject: null }).allowed).toBe(false)
    const admin = { codes: new Set<string>(), globalCodes: new Set([CODE]) }
    expect(authorizeAppState({ caller: c, registration: admin, interaction: 'create', stateCode: CODE, subject: null }).allowed).toBe(true)
  })
})

describe('callerFromToken', () => {
  it('reads client, scopes, patient and fhirUser from the token', () => {
    const c = callerFromToken({ azp: 'demo-app', scope: 'openid patient/Basic.s', patient: 'a', fhirUser: `${BASE}/Practitioner/b` })
    expect(c.clientId).toBe('demo-app')
    expect([...c.scopes]).toContain('patient/Basic.s')
    expect(c.patient).toBe('Patient/a')
    expect(c.users).toContain('Practitioner/b')
  })

  it('uses the fhirUser resolved at token issuance, not only the raw claim', () => {
    tokenContextStore.set('jti-app-state', { fhirUser: `${BASE}/Practitioner/resolved`, clientId: 'demo-app' })
    const c = callerFromToken({ azp: 'demo-app', jti: 'jti-app-state', fhirUser: 'Person/p1' })
    expect(c.users).toContain('Practitioner/resolved')
    expect(c.users).toContain('Person/p1')
  })

  it('falls back to client_id when azp is absent', () => {
    expect(callerFromToken({ client_id: 'svc' }).clientId).toBe('svc')
  })
})
