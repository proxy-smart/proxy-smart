// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type UserRepresentation from '@keycloak/keycloak-admin-client/lib/defs/userRepresentation.js'

const PERSON = { serverId: 'hapi', personId: 'Person/1' }

function fakeAdmin(attributes: Record<string, string[]>) {
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
  const written: UserRepresentation[] = []
  admin.users.findOne = async (query) => ({ id: query?.id, username: 'jdoe', attributes })
  admin.users.update = async (_query, rep) => { written.push(rep) }
  return { admin, written }
}

let current = fakeAdmin({})

mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async () => current.admin),
}))

const { healthcareUsersRoutes } = await import('../src/routes/admin/healthcare-users')
const app = new Elysia().use(healthcareUsersRoutes)

const put = (body: unknown) => app.handle(new Request('http://localhost/healthcare-users/u1', {
  method: 'PUT',
  headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))

const STORED = { fhir_persons: [JSON.stringify([PERSON])], fhirUser: ['Practitioner/7'], organization: ['acme'] }

beforeEach(() => {
  current = fakeAdmin({ ...STORED })
})

describe('PUT /healthcare-users/:userId profile attributes', () => {
  it('clears the Person associations when an empty list is sent', async () => {
    expect((await put({ fhirPersons: [] })).status).toBe(200)
    expect(current.written[0]?.attributes?.fhir_persons).toBeUndefined()
    expect(current.written[0]?.attributes?.fhirUser).toEqual(['Practitioner/7'])
  })

  it('keeps every attribute the request leaves out', async () => {
    expect((await put({ firstName: 'Jane' })).status).toBe(200)
    expect(current.written[0]?.attributes).toEqual(STORED)
  })

  it('clears fhirUser and organization when sent empty', async () => {
    expect((await put({ fhirUser: '', organization: '' })).status).toBe(200)
    expect(current.written[0]?.attributes?.fhirUser).toBeUndefined()
    expect(current.written[0]?.attributes?.organization).toBeUndefined()
  })
})
