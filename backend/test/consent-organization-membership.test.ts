// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type OrganizationRepresentation from '@keycloak/keycloak-admin-client/lib/defs/organizationRepresentation.js'

const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
let organizations: OrganizationRepresentation[] = []
let membershipCalls = 0

const answerMemberships: typeof admin.organizations.memberOrganizations = async () => {
  membershipCalls++
  return organizations.map(({ id }) => ({ id }))
}
admin.organizations.findOne = async (query) => organizations.find((org) => org.id === query?.id) ?? {}

mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => admin,
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

const { FHIR_ORGANIZATION_ATTRIBUTE, invalidateOrganizationMemberships, memberFhirOrganizations, practitionerOrganizations } =
  await import('../src/lib/consent/organization-membership')

describe('memberFhirOrganizations', () => {
  beforeEach(() => {
    invalidateOrganizationMemberships()
    admin.organizations.memberOrganizations = answerMemberships
    membershipCalls = 0
    organizations = []
  })

  it('maps Keycloak memberships to the FHIR Organizations they name', async () => {
    organizations = [
      { id: 'kc-1', attributes: { [FHIR_ORGANIZATION_ATTRIBUTE]: ['max-health'] } },
      { id: 'kc-2', attributes: {} },
    ]
    expect([...await memberFhirOrganizations('user-1')]).toEqual(['max-health'])
  })

  it('asks Keycloak once per user while the answer is fresh', async () => {
    await memberFhirOrganizations('user-1')
    await memberFhirOrganizations('user-1')
    expect(membershipCalls).toBe(1)
  })

  it('grants nothing without a user or when Keycloak fails', async () => {
    expect((await memberFhirOrganizations(null)).size).toBe(0)
    admin.organizations.memberOrganizations = async () => { throw new Error('down') }
    expect((await memberFhirOrganizations('user-2')).size).toBe(0)
  })

  it('names practitioners only, so patients in the same organization gain nothing', async () => {
    organizations = [{ id: 'kc-1', attributes: { [FHIR_ORGANIZATION_ATTRIBUTE]: ['max-health'] } }]
    const linkedTo = (resolved: string | undefined) => async () => resolved
    expect([...await practitionerOrganizations({ userId: 'u1', fhirUser: 'Person/p1' }, linkedTo('Practitioner/dr-1'))]).toEqual(['max-health'])
    expect([...await practitionerOrganizations({ userId: 'u1', fhirUser: 'PractitionerRole/r1' }, linkedTo('PractitionerRole/r1'))]).toEqual(['max-health'])
    expect((await practitionerOrganizations({ userId: 'u1', fhirUser: 'Person/p2' }, linkedTo(undefined))).size).toBe(0)
    expect((await practitionerOrganizations({ userId: 'u1', fhirUser: 'Patient/p3' }, linkedTo(undefined))).size).toBe(0)
    expect((await practitionerOrganizations({ userId: 'u1', fhirUser: null }, linkedTo('Practitioner/dr-1'))).size).toBe(0)
  })
})
