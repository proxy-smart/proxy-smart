// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { authorizeAppState, type AppStateInteraction } from '../src/lib/app-state/access'
import { callerFromToken, type AppStateCaller, type AppStateFhirServer } from '../src/lib/app-state/context'
import { buildAppStateRegistration, type AppStateRegistration } from '../src/lib/app-state/registration'
import { tokenContextStore } from '../src/lib/token-context-store'

const BASE = 'https://proxy.example.org/proxy-smart-backend/hapi/R4'
const OTHER_BASE = 'https://proxy.example.org/proxy-smart-backend/other/R4'
const CODE = 'https://app.example.org|prefs'
const OTHER_CODE = 'https://app.example.org|keys'
const PATIENT = `${BASE}/Patient/a`
const PRACTITIONER = `${BASE}/Practitioner/b`

const ONE_SERVER: AppStateFhirServer[] = [{ base: BASE, upstream: 'http://hapi:8080/fhir' }]
const TWO_SERVERS: AppStateFhirServer[] = [...ONE_SERVER, { base: OTHER_BASE, upstream: 'http://other:8080/fhir' }]

function caller(overrides: Partial<AppStateCaller> = {}): AppStateCaller {
  return {
    clientId: 'demo-app',
    scopes: new Set(['patient/Basic.cuds', 'user/Basic.cuds']),
    patient: PATIENT,
    users: [PRACTITIONER],
    unbound: null,
    ...overrides,
  }
}

const registered: AppStateRegistration = buildAppStateRegistration({ codes: [CODE] })

function allowed(input: { caller?: AppStateCaller; registration?: AppStateRegistration; interaction: AppStateInteraction; stateCode?: string; subject: string | null }): boolean {
  return authorizeAppState({
    caller: input.caller ?? caller(),
    registration: input.registration ?? registered,
    interaction: input.interaction,
    stateCode: input.stateCode ?? CODE,
    subject: input.subject,
  }).allowed
}

describe('authorizeAppState: state codes are tied to the app registration', () => {
  it('allows a registered code on the in-context patient', () => {
    expect(allowed({ interaction: 'create', subject: PATIENT })).toBe(true)
  })

  it('refuses a code the app is not registered for, whatever its scopes', () => {
    expect(allowed({ interaction: 'search', stateCode: OTHER_CODE, subject: PATIENT })).toBe(false)
  })

  it('treats a global-write code as registered for queries too', () => {
    const registration = buildAppStateRegistration({ globalCodes: [CODE] })
    expect(allowed({ registration, interaction: 'search', subject: PATIENT })).toBe(true)
  })
})

describe('authorizeAppState: per-code permissions per subject', () => {
  const broad = caller({ scopes: new Set(['patient/*.cruds', 'user/*.*']) })

  it('lets a companion app registered to query a code read it but never modify it, whatever its scopes', () => {
    const companion = buildAppStateRegistration({ permissions: { patient: { query: [CODE] } } })
    expect(allowed({ caller: broad, registration: companion, interaction: 'search', subject: PATIENT })).toBe(true)
    const writes: AppStateInteraction[] = ['create', 'update', 'delete']
    for (const interaction of writes) {
      expect(allowed({ caller: broad, registration: companion, interaction, subject: PATIENT })).toBe(false)
    }
  })

  it('keeps patient, user and global permissions apart', () => {
    const userOnly = buildAppStateRegistration({ permissions: { user: { query: [CODE], modify: [CODE] } } })
    expect(allowed({ caller: broad, registration: userOnly, interaction: 'update', subject: PRACTITIONER })).toBe(true)
    expect(allowed({ caller: broad, registration: userOnly, interaction: 'update', subject: PATIENT })).toBe(false)
    expect(allowed({ caller: broad, registration: userOnly, interaction: 'search', subject: null })).toBe(false)
  })

  it('separates querying global state from modifying it', () => {
    const globalReader = buildAppStateRegistration({ permissions: { global: { query: [CODE] } } })
    expect(allowed({ caller: broad, registration: globalReader, interaction: 'search', subject: null })).toBe(true)
    expect(allowed({ caller: broad, registration: globalReader, interaction: 'create', subject: null })).toBe(false)
  })

  it('does not let modify imply query', () => {
    const writer = buildAppStateRegistration({ permissions: { patient: { modify: [CODE] } } })
    expect(allowed({ registration: writer, interaction: 'create', subject: PATIENT })).toBe(true)
    expect(allowed({ registration: writer, interaction: 'search', subject: PATIENT })).toBe(false)
  })

  it('allows a subject that is both patient and user through either registration', () => {
    const self = caller({ users: [PATIENT], scopes: new Set(['user/Basic.cuds']) })
    const userOnly = buildAppStateRegistration({ permissions: { user: { modify: [CODE] } } })
    expect(allowed({ caller: self, registration: userOnly, interaction: 'create', subject: PATIENT })).toBe(true)
  })
})

describe('authorizeAppState: subject must be the in-context patient or the user', () => {
  it('refuses another patient', () => {
    expect(allowed({ interaction: 'search', subject: `${BASE}/Patient/z` })).toBe(false)
  })

  it('refuses the in-context patient id on a different FHIR server', () => {
    expect(allowed({ interaction: 'search', subject: `${OTHER_BASE}/Patient/a` })).toBe(false)
  })

  it('allows the in-context user with a user-level scope', () => {
    expect(allowed({ caller: caller({ scopes: new Set(['user/Basic.cuds']) }), interaction: 'update', subject: PRACTITIONER })).toBe(true)
  })

  it('does not let a patient-level scope reach user state', () => {
    expect(allowed({ caller: caller({ scopes: new Set(['patient/Basic.cuds']) }), interaction: 'search', subject: PRACTITIONER })).toBe(false)
  })

  it('lets a user-level scope write patient state on behalf of the user', () => {
    expect(allowed({ caller: caller({ scopes: new Set(['user/Basic.cuds']) }), interaction: 'create', subject: PATIENT })).toBe(true)
  })

  it('accepts PractitionerRole as the user', () => {
    const c = caller({ users: [`${BASE}/PractitionerRole/r1`], scopes: new Set(['user/Basic.s']) })
    expect(allowed({ caller: c, interaction: 'search', subject: `${BASE}/PractitionerRole/r1` })).toBe(true)
  })

  it('refuses a patient subject when the token has no patient context, and says why it is unbound', () => {
    const c = caller({ patient: null, users: [], unbound: 'The access token does not name the FHIR server' })
    const decision = authorizeAppState({ caller: c, registration: registered, interaction: 'search', stateCode: CODE, subject: PATIENT })
    expect(decision.allowed).toBe(false)
    expect(decision.allowed ? '' : decision.reason).toContain('does not name the FHIR server')
  })
})

describe('authorizeAppState: scopes', () => {
  it('maps interactions onto SMART v2 permission characters', () => {
    const readOnly = caller({ scopes: new Set(['patient/Basic.s']) })
    expect(allowed({ caller: readOnly, interaction: 'search', subject: PATIENT })).toBe(true)
    expect(allowed({ caller: readOnly, interaction: 'create', subject: PATIENT })).toBe(false)
    expect(allowed({ caller: readOnly, interaction: 'update', subject: PATIENT })).toBe(false)
    expect(allowed({ caller: readOnly, interaction: 'delete', subject: PATIENT })).toBe(false)
  })

  it('honours a code-narrowed scope', () => {
    const narrowed = caller({ scopes: new Set([`patient/Basic.cuds?code=${CODE}`]) })
    const registration = buildAppStateRegistration({ codes: [CODE, OTHER_CODE] })
    expect(allowed({ caller: narrowed, registration, interaction: 'create', subject: PATIENT })).toBe(true)
    expect(allowed({ caller: narrowed, registration, interaction: 'create', stateCode: OTHER_CODE, subject: PATIENT })).toBe(false)
  })

  it('reads a literal + in a code-narrowed scope as a plus, not a space', () => {
    const plus = 'https://app.example.org|a+b'
    const registration = buildAppStateRegistration({ codes: [plus] })
    const narrowed = caller({ scopes: new Set([`patient/Basic.cuds?code=${plus}`]) })
    expect(allowed({ caller: narrowed, registration, interaction: 'create', stateCode: plus, subject: PATIENT })).toBe(true)
  })

  it('does not treat a scope narrowed by an unknown parameter as unrestricted', () => {
    expect(allowed({ caller: caller({ scopes: new Set(['patient/Basic.cuds?category=x']) }), interaction: 'search', subject: PATIENT })).toBe(false)
  })

  it('accepts resource wildcards and SMART v1 read/write', () => {
    expect(allowed({ caller: caller({ scopes: new Set(['patient/*.cruds']) }), interaction: 'delete', subject: PATIENT })).toBe(true)
    const v1 = caller({ scopes: new Set(['patient/Basic.read']) })
    expect(allowed({ caller: v1, interaction: 'search', subject: PATIENT })).toBe(true)
    expect(allowed({ caller: v1, interaction: 'create', subject: PATIENT })).toBe(false)
  })

  it('ignores scopes for other resource types', () => {
    expect(allowed({ caller: caller({ scopes: new Set(['patient/Observation.cruds']) }), interaction: 'search', subject: PATIENT })).toBe(false)
  })
})

describe('authorizeAppState: global app state', () => {
  it('queries global state with user/Basic.s', () => {
    expect(allowed({ caller: caller({ scopes: new Set(['user/Basic.s']) }), interaction: 'search', subject: null })).toBe(true)
  })

  it('does not let a patient-level scope query global state', () => {
    expect(allowed({ caller: caller({ scopes: new Set(['patient/Basic.cuds']) }), interaction: 'search', subject: null })).toBe(false)
  })

  it('keeps global writes for apps registered as administrative for that code', () => {
    const c = caller({ scopes: new Set(['user/Basic.cuds']) })
    expect(allowed({ caller: c, interaction: 'create', subject: null })).toBe(false)
    expect(allowed({ caller: c, registration: buildAppStateRegistration({ globalCodes: [CODE] }), interaction: 'create', subject: null })).toBe(true)
  })
})

describe('callerFromToken', () => {
  it('reads client, scopes, patient and fhirUser, bound to the only FHIR server', async () => {
    const c = await callerFromToken({ azp: 'demo-app', scope: 'openid patient/Basic.s', patient: 'a', fhirUser: PRACTITIONER }, ONE_SERVER)
    expect(c.clientId).toBe('demo-app')
    expect([...c.scopes]).toContain('patient/Basic.s')
    expect(c.patient).toBe(PATIENT)
    expect(c.users).toContain(PRACTITIONER)
  })

  it('uses the fhirUser resolved at token issuance, not only the raw claim', async () => {
    await tokenContextStore.set('jti-app-state', { fhirUser: `${BASE}/Practitioner/resolved`, clientId: 'demo-app' })
    const c = await callerFromToken({ azp: 'demo-app', jti: 'jti-app-state', fhirUser: 'Person/p1' }, ONE_SERVER)
    expect(c.users).toContain(`${BASE}/Practitioner/resolved`)
    expect(c.users).toContain(`${BASE}/Person/p1`)
  })

  it('falls back to client_id when azp is absent', async () => {
    expect((await callerFromToken({ client_id: 'svc' }, ONE_SERVER)).clientId).toBe('svc')
  })

  it('binds the context to the FHIR server named in aud', async () => {
    const c = await callerFromToken({ azp: 'demo-app', aud: [OTHER_BASE, 'fhir-resource-server'], patient: 'a', fhirUser: 'Practitioner/b' }, TWO_SERVERS)
    expect(c.patient).toBe(`${OTHER_BASE}/Patient/a`)
    expect(c.users).toEqual([`${OTHER_BASE}/Practitioner/b`])
  })

  it('recognises the upstream base of a server in aud, with or without a trailing slash', async () => {
    const c = await callerFromToken({ azp: 'demo-app', aud: 'http://other:8080/fhir/', patient: 'a' }, TWO_SERVERS)
    expect(c.patient).toBe(`${OTHER_BASE}/Patient/a`)
  })

  it('refuses to guess the server in a multi-server deployment', async () => {
    const c = await callerFromToken({ azp: 'demo-app', patient: 'a', fhirUser: 'Practitioner/b' }, TWO_SERVERS)
    expect(c.patient).toBeNull()
    expect(c.users).toEqual([])
    expect(c.unbound).toContain('FHIR server')
  })

  it('treats a token naming several FHIR servers as ambiguous', async () => {
    const c = await callerFromToken({ azp: 'demo-app', aud: [BASE, OTHER_BASE], patient: 'a' }, TWO_SERVERS)
    expect(c.patient).toBeNull()
    expect(c.unbound).toContain('several')
  })

  it('binds an absolute fhirUser to its own server, and ignores one on a server the proxy does not serve', async () => {
    const own = await callerFromToken({ azp: 'demo-app', fhirUser: `${OTHER_BASE}/Practitioner/b` }, TWO_SERVERS)
    expect(own.users).toEqual([`${OTHER_BASE}/Practitioner/b`])
    const foreign = await callerFromToken({ azp: 'demo-app', fhirUser: 'https://elsewhere.example.org/fhir/Practitioner/b' }, TWO_SERVERS)
    expect(foreign.users).toEqual([])
  })
})
