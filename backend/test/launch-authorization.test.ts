// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { authorizeLaunchMint } from '../src/lib/launch-authorization'
import type { CallerIdentityDeps } from '../src/lib/caller-identity'

const server = { url: 'https://fhir.example.com', identifier: 'hapi' }

function deps(ownPatient: string | null, practitioner?: string): CallerIdentityDeps {
  return {
    server: async () => server,
    ownPatientId: async () => ownPatient,
    practitionerOf: async () => practitioner,
  }
}

describe('who may mint a launch code', () => {
  it('lets a member launch for their own patient record, named either way', async () => {
    const member = { sub: 'u1', fhirUser: 'Person/p1' }
    expect(await authorizeLaunchMint(member, { patient: 'Patient/1005' }, 'Bearer t', deps('1005'))).toEqual({ allowed: true })
    expect(await authorizeLaunchMint(member, { patient: '1005' }, 'Bearer t', deps('1005'))).toEqual({ allowed: true })
  })

  it('refuses a member launching for someone else\'s patient record', async () => {
    const member = { sub: 'u2', fhirUser: 'Person/p2' }
    expect((await authorizeLaunchMint(member, { patient: 'Patient/1005' }, 'Bearer t', deps('2002'))).allowed).toBe(false)
  })

  it('refuses a caller with no record of their own', async () => {
    expect((await authorizeLaunchMint({ sub: 'u3' }, { patient: 'Patient/1005' }, 'Bearer t', deps(null))).allowed).toBe(false)
  })

  it('lets a practitioner launch for a patient, directly or through their Person', async () => {
    expect(await authorizeLaunchMint({ fhirUser: 'Practitioner/dr' }, { patient: 'Patient/1005' }, 'Bearer t', deps(null))).toEqual({ allowed: true })
    expect(await authorizeLaunchMint({ fhirUser: 'Person/dr' }, { patient: 'Patient/1005' }, 'Bearer t', deps(null, 'Practitioner/dr'))).toEqual({ allowed: true })
  })

  it('only lets a launch name the caller as fhirUser', async () => {
    const member = { sub: 'u1', fhirUser: 'Person/p1' }
    expect((await authorizeLaunchMint(member, { fhirUser: 'Practitioner/dr' }, 'Bearer t', deps('1005'))).allowed).toBe(false)
    expect(await authorizeLaunchMint(member, { fhirUser: 'Person/p1' }, 'Bearer t', deps('1005'))).toEqual({ allowed: true })
  })
})
