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
admin.clients.find = async (query) => query?.clientId === 'provisioning'
  ? [{ id: 'kc-client-1', clientId: 'provisioning', serviceAccountsEnabled: true }]
  : [{ id: 'kc-client-2', clientId: query?.clientId, serviceAccountsEnabled: false }]
admin.clients.getServiceAccountUser = async (query) => ({ id: query?.id === 'kc-client-1' ? 'sa-provisioning' : undefined })

mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => admin,
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

const { FHIR_ORGANIZATION_ATTRIBUTE, actingPractitioner, invalidateOrganizationMemberships, memberFhirOrganizations, requesterOrganizations } =
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

  it('names practitioners, so patients in the same organization gain nothing', async () => {
    organizations = [{ id: 'kc-1', attributes: { [FHIR_ORGANIZATION_ATTRIBUTE]: ['max-health'] } }]
    expect([...await requesterOrganizations({ clientId: 'portal', userId: 'u1', practitioner: 'Practitioner/dr-1' })]).toEqual(['max-health'])
    expect((await requesterOrganizations({ clientId: 'portal', userId: 'u1', practitioner: null })).size).toBe(0)
  })

  it("names a backend service whose own service account is a member, and no one signing in through it", async () => {
    organizations = [{ id: 'kc-1', attributes: { [FHIR_ORGANIZATION_ATTRIBUTE]: ['max-health'] } }]
    expect([...await requesterOrganizations({ clientId: 'provisioning', userId: 'sa-provisioning', practitioner: null })]).toEqual(['max-health'])
    expect((await requesterOrganizations({ clientId: 'provisioning', userId: 'someone-else', practitioner: null })).size).toBe(0)
    expect((await requesterOrganizations({ clientId: 'portal', userId: 'sa-provisioning', practitioner: null })).size).toBe(0)
    expect((await requesterOrganizations({ clientId: 'provisioning', userId: null, practitioner: null })).size).toBe(0)
  })

  it('grants a backend service nothing when Keycloak cannot say whose service account it is', async () => {
    organizations = [{ id: 'kc-1', attributes: { [FHIR_ORGANIZATION_ATTRIBUTE]: ['max-health'] } }]
    const answerClients = admin.clients.find
    admin.clients.find = async () => { throw new Error('down') }
    try {
      expect((await requesterOrganizations({ clientId: 'provisioning', userId: 'sa-provisioning', practitioner: null })).size).toBe(0)
    } finally {
      admin.clients.find = answerClients
    }
  })

  it('acts as the Practitioner or PractitionerRole a login resolves to, and as no one else', async () => {
    const linkedTo = (resolved: string | undefined) => async () => resolved
    expect(await actingPractitioner('Person/p1', linkedTo('Practitioner/dr-1'))).toBe('Practitioner/dr-1')
    expect(await actingPractitioner('PractitionerRole/r1', linkedTo('PractitionerRole/r1'))).toBe('PractitionerRole/r1')
    expect(await actingPractitioner('Person/p2', linkedTo('https://fhir.example/fhir/Practitioner/dr-2'))).toBe('Practitioner/dr-2')
    expect(await actingPractitioner('Person/p3', linkedTo('Patient/p3'))).toBeNull()
    expect(await actingPractitioner('Person/p4', linkedTo(undefined))).toBeNull()
    expect(await actingPractitioner(null, linkedTo('Practitioner/dr-1'))).toBeNull()
  })
})
