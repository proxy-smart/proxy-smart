// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock } from 'bun:test'

let memberOrganizations: (q: { userId: string }) => Promise<{ id?: string; name?: string; alias?: string }[]>

const USERS = [
  { id: 'u-doctor', username: 'doctor', email: 'doctor@example.com', firstName: 'Jane', lastName: 'Smith', enabled: true, attributes: { fhirUser: ['Practitioner/p1'], organization: ['Imported Clinic'] } },
  { id: 'u-patient', username: 'patient', email: '', firstName: '', lastName: '', enabled: true, attributes: {} },
]

const admin = {
  users: {
    find: async () => USERS,
    findOne: async ({ id }: { id: string }) => USERS.find((u) => u.id === id) ?? null,
    listRealmRoleMappings: async () => [],
    listClientRoleMappings: async () => [],
    listFederatedIdentities: async () => [],
  },
  clients: { find: async () => [{ id: 'client-admin-ui', clientId: 'admin-ui' }] },
  organizations: { memberOrganizations: (q: { userId: string }) => memberOrganizations(q) },
}

mock.module('@/lib/keycloak-plugin', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Elysia } = require('elysia')
  return {
    createAdminClient: async () => admin,
    keycloakPlugin: new Elysia().decorate('getAdmin', async () => admin),
  }
})

const noopLogger: unknown = new Proxy(function () {}, { get: () => noopLogger, apply: () => undefined })
mock.module('@/lib/logger', () => ({ logger: noopLogger }))

const { healthcareUsersRoutes } = await import('../src/routes/admin/healthcare-users')
const { Elysia } = await import('elysia')

async function listUsers(): Promise<{ status: number; body: { id: string; organization?: string; organizations?: unknown[] }[] }> {
  const app = new Elysia().group('/admin', (a) => a.use(healthcareUsersRoutes))
  const res = await app.handle(new Request('http://localhost/admin/healthcare-users/', { headers: { authorization: 'Bearer t' } }))
  return { status: res.status, body: await res.json() }
}

describe('GET /admin/healthcare-users organizations', () => {
  it('lists Keycloak Organization membership apart from the imported organization attribute', async () => {
    memberOrganizations = async ({ userId }) =>
      userId === 'u-doctor' ? [{ id: 'org-1', name: 'Max Health', alias: 'max-health' }, { id: 'org-2' }] : []

    const { status, body } = await listUsers()

    expect(status).toBe(200)
    const doctor = body.find((u) => u.id === 'u-doctor')
    expect(doctor?.organizations).toEqual([{ id: 'org-1', name: 'Max Health', alias: 'max-health' }])
    expect(doctor?.organization).toBe('Imported Clinic')
    expect(body.find((u) => u.id === 'u-patient')?.organizations).toEqual([])
  })

  it('still lists users when Keycloak cannot say, as on a realm with Organizations off', async () => {
    memberOrganizations = async () => { throw new Error('Organizations not enabled for this realm') }

    const { status, body } = await listUsers()

    expect(status).toBe(200)
    expect(body.map((u) => u.organizations)).toEqual([[], []])
  })
})
