// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { makeLaunchSession } from '@proxy-smart/auth/testing'

mockLoggerModule()

let restrictions = { allowedFhirUserTypes: ['Practitioner', 'PractitionerRole'], requiredRoles: [] as string[] }
let account: { fhirUser?: string; realm: string[]; own: string[] } = { realm: [], own: [] }
let sessionUser: string | null = 'user-1'

mock.module('@/lib/smart-client-config-cache', () => ({
  getClientUserRestrictions: async () => restrictions,
  getSmartClientConfig: async () => ({ redirectUris: [] }),
  getRegisteredRedirectUris: async () => [],
  invalidateClientConfig: () => {},
  clearClientConfigCache: () => {},
}))
mock.module('@/lib/kc-session-resolver', () => ({
  findSessionUserId: async () => sessionUser,
  autoResolvePatient: async () => null,
}))
mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => ({
    users: {
      findOne: async () => ({ attributes: account.fhirUser ? { fhirUser: [account.fhirUser] } : {} }),
      listCompositeRealmRoleMappings: async () => account.realm.map((name) => ({ name })),
      listCompositeClientRoleMappings: async () => account.own.map((name) => ({ name })),
    },
    clients: { find: async () => [{ id: 'dtr-uuid', clientId: 'dtr-app' }] },
  }),
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

const { admitUser } = await import('../src/routes/auth/oauth/shared')

const session = makeLaunchSession({ clientId: 'dtr-app', scope: 'openid fhirUser launch user/*.rs' })
const admit = (sessionState: string | null = 'kc-session') =>
  admitUser(session, { state: 's', code: 'c', ...(sessionState && { session_state: sessionState }) })

describe('admitUser at the SMART callback', () => {
  beforeEach(() => {
    restrictions = { allowedFhirUserTypes: ['Practitioner', 'PractitionerRole'], requiredRoles: [] }
    account = { realm: [], own: [] }
    sessionUser = 'user-1'
  })

  it('turns a patient away with access_denied and the reason', async () => {
    account.fhirUser = 'Patient/p-1'
    expect(await admit()).toEqual({ error: 'access_denied', error_description: 'This app is only available to Practitioner or PractitionerRole accounts.' })
  })

  it('admits a practitioner', async () => {
    account.fhirUser = 'Practitioner/dr-1'
    expect(await admit()).toBeNull()
  })

  it('reads required roles from the realm and from the client itself', async () => {
    restrictions = { allowedFhirUserTypes: [], requiredRoles: ['clinician', 'prior-auth'] }
    account = { realm: ['clinician'], own: ['prior-auth'] }
    expect(await admit()).toBeNull()
    account = { realm: ['clinician'], own: [] }
    expect(await admit()).toMatchObject({ error: 'access_denied' })
  })

  it('leaves the decision to the token endpoint when it cannot tell who signed in', async () => {
    account.fhirUser = 'Patient/p-1'
    expect(await admit(null)).toBeNull()
    sessionUser = null
    expect(await admit()).toBeNull()
  })

  it('does not look anyone up for a client that restricts nobody', async () => {
    restrictions = { allowedFhirUserTypes: [], requiredRoles: [] }
    account.fhirUser = 'Patient/p-1'
    expect(await admit()).toBeNull()
  })
})
