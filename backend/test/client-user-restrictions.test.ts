// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock } from 'bun:test'
import { checkUserRestrictions, type UserRestrictionDeps } from '../src/lib/client-user-restrictions'
import { parseUserRestrictions, type UserRestrictions } from '../src/lib/smart-client-enrichment'

const CLINICIANS: UserRestrictions = { allowedFhirUserTypes: ['Practitioner', 'PractitionerRole'], requiredRoles: [] }

function deps(restrictions: UserRestrictions, links: Partial<Record<'patient' | 'practitioner', string>> = {}): UserRestrictionDeps {
  return {
    restrictions: mock(async () => restrictions),
    linkedIdentity: mock(async (_fhirUser: string, patientFacing: boolean) => patientFacing ? links.patient : links.practitioner),
  }
}

const token = (claims: Record<string, unknown> = {}) => ({ azp: 'dtr-app', sub: 'u1', ...claims })

describe('parseUserRestrictions', () => {
  it('reads the client attributes the admin API writes', () => {
    expect(parseUserRestrictions({ allowed_fhir_user_types: 'Practitioner, PractitionerRole', required_roles: ['clinician'] }))
      .toEqual({ allowedFhirUserTypes: ['Practitioner', 'PractitionerRole'], requiredRoles: ['clinician'] })
    expect(parseUserRestrictions(undefined)).toEqual({ allowedFhirUserTypes: [], requiredRoles: [] })
  })
})

describe('checkUserRestrictions', () => {
  it('lets everyone through a client that restricts nobody, without resolving anyone', async () => {
    const d = deps({ allowedFhirUserTypes: [], requiredRoles: [] })
    expect(await checkUserRestrictions(token({ fhirUser: 'Person/1' }), d)).toEqual({ allowed: true })
    expect(d.linkedIdentity).not.toHaveBeenCalled()
  })

  it('admits a practitioner, and a Person that links to one', async () => {
    expect(await checkUserRestrictions(token({ fhirUser: 'Practitioner/7' }), deps(CLINICIANS))).toEqual({ allowed: true })
    expect(await checkUserRestrictions(token({ fhirUser: 'https://fhir.example.com/PractitionerRole/7' }), deps(CLINICIANS))).toEqual({ allowed: true })
    expect(await checkUserRestrictions(token({ fhirUser: 'Person/1' }), deps(CLINICIANS, { practitioner: 'Practitioner/7' }))).toEqual({ allowed: true })
  })

  it('refuses a patient, a Person linked only to a patient, and an account with no FHIR identity', async () => {
    for (const [fhirUser, links] of [
      ['Patient/3', {}],
      ['Person/1', { patient: 'Patient/3' }],
      [undefined, {}],
    ] as const) {
      const outcome = await checkUserRestrictions(token(fhirUser ? { fhirUser } : {}), deps(CLINICIANS, links))
      expect(outcome).toMatchObject({ allowed: false, status: 400, error: 'invalid_grant' })
    }
  })

  it('looks a Person up only for the identity types the client allows', async () => {
    const d = deps({ allowedFhirUserTypes: ['Patient'], requiredRoles: [] }, { patient: 'Patient/3', practitioner: 'Practitioner/7' })
    expect(await checkUserRestrictions(token({ fhirUser: 'Person/1' }), d)).toEqual({ allowed: true })
    expect(d.linkedIdentity).toHaveBeenCalledTimes(1)
    expect(d.linkedIdentity).toHaveBeenCalledWith('Person/1', true)
  })

  it('requires every listed role, held in the realm or on the client itself', async () => {
    const restricted = deps({ allowedFhirUserTypes: [], requiredRoles: ['clinician', 'prior-auth'] })
    const holder = token({ realm_access: { roles: ['clinician'] }, resource_access: { 'dtr-app': { roles: ['prior-auth'] } } })
    expect(await checkUserRestrictions(holder, restricted)).toEqual({ allowed: true })

    const elsewhere = token({ realm_access: { roles: ['clinician'] }, resource_access: { 'other-app': { roles: ['prior-auth'] } } })
    expect(await checkUserRestrictions(elsewhere, restricted)).toMatchObject({ allowed: false, error: 'invalid_grant' })
  })

  it('applies both restrictions together', async () => {
    const d = deps({ allowedFhirUserTypes: ['Practitioner'], requiredRoles: ['clinician'] })
    expect(await checkUserRestrictions(token({ fhirUser: 'Practitioner/7' }), d)).toMatchObject({ allowed: false })
    expect(await checkUserRestrictions(token({ fhirUser: 'Practitioner/7', realm_access: { roles: ['clinician'] } }), d)).toEqual({ allowed: true })
  })

  it('refuses rather than guesses when the client restrictions cannot be read', async () => {
    const d: UserRestrictionDeps = {
      restrictions: mock(async () => { throw new Error('Keycloak unreachable') }),
      linkedIdentity: mock(async () => undefined),
    }
    expect(await checkUserRestrictions(token({ fhirUser: 'Practitioner/7' }), d))
      .toMatchObject({ allowed: false, status: 503, error: 'temporarily_unavailable' })
  })

  it('reads the account when the token scope left fhirUser out', async () => {
    const d: UserRestrictionDeps = { ...deps(CLINICIANS), accountFhirUser: mock(async () => 'Practitioner/7') }
    expect(await checkUserRestrictions(token(), d)).toEqual({ allowed: true })
    expect(d.accountFhirUser).toHaveBeenCalledWith('u1')
  })

  it('has nothing to check on a token that names no client', async () => {
    const d = deps(CLINICIANS)
    expect(await checkUserRestrictions({ sub: 'u1', fhirUser: 'Patient/3' }, d)).toEqual({ allowed: true })
    expect(d.restrictions).not.toHaveBeenCalled()
  })
})

describe('a client that requires an upstream acr', () => {
  const STRONG: UserRestrictions = { allowedFhirUserTypes: [], requiredRoles: [], requiredAcr: 'gold' }

  it('reads required_acr from the client attributes', () => {
    expect(parseUserRestrictions({ required_acr: 'gold' }).requiredAcr).toBe('gold')
    expect(parseUserRestrictions({ required_acr: '' }).requiredAcr).toBeUndefined()
  })

  it('issues tokens whose upstream_acr matches, including a silent or refreshed one from the same session', async () => {
    expect(await checkUserRestrictions(token({ upstream_acr: 'gold', acr: '1' }), deps(STRONG))).toEqual({ allowed: true })
    expect(await checkUserRestrictions(token({ upstream_acr: 'gold', acr: '0' }), deps(STRONG))).toEqual({ allowed: true })
  })

  it('refuses a sign-in the upstream reported otherwise, or not at all', async () => {
    for (const claims of [{}, { upstream_acr: 'silver' }, { acr: 'gold' }]) {
      expect(await checkUserRestrictions(token(claims), deps(STRONG))).toMatchObject({ allowed: false, status: 400, error: 'invalid_grant' })
    }
  })
})
