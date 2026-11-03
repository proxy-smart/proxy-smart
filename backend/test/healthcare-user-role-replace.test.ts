// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type RoleRepresentation from '@keycloak/keycloak-admin-client/lib/defs/roleRepresentation.js'

const REALM_ROLES = [{ id: 'r-user', name: 'user' }, { id: 'r-admin', name: 'admin' }, { id: 'r-default', name: 'default-roles-test' }]
const ADMIN_UI = { id: 'client-admin-ui', clientId: 'admin-ui' }
const CLIENT_ROLES = [{ id: 'c-admin', name: 'admin' }, { id: 'c-practitioner', name: 'practitioner' }]

function fakeAdmin(held: { realm: RoleRepresentation[]; client: RoleRepresentation[] }, failAdd = false) {
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
  const log: string[] = []
  const names = (roles: RoleRepresentation[]) => roles.map((r) => r.name).join(',')
  admin.users.findOne = async (query) => ({ id: query?.id, username: 'jdoe', attributes: {} })
  admin.users.update = async () => {}
  admin.roles.find = async () => REALM_ROLES
  admin.users.listRealmRoleMappings = async () => held.realm
  admin.users.delRealmRoleMappings = async (payload) => { log.push(`realm-del:${names(payload?.roles ?? [])}`) }
  admin.users.addRealmRoleMappings = async (payload) => {
    if (failAdd) throw new Error('Keycloak refused')
    log.push(`realm-add:${names(payload?.roles ?? [])}`)
  }
  admin.clients.find = async (query) => (query?.clientId === 'admin-ui' ? [ADMIN_UI] : [])
  admin.clients.listRoles = async () => CLIENT_ROLES
  admin.users.listClientRoleMappings = async () => held.client
  admin.users.delClientRoleMappings = async (payload) => { log.push(`client-del:${names(payload?.roles ?? [])}`) }
  admin.users.addClientRoleMappings = async (payload) => { log.push(`client-add:${names(payload?.roles ?? [])}`) }
  return { admin, log }
}

let current = fakeAdmin({ realm: [], client: [] })

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

beforeEach(() => {
  current = fakeAdmin({ realm: [], client: [] })
})

describe('PUT /healthcare-users/:userId role replacement', () => {
  it('touches only the realm roles that change', async () => {
    current = fakeAdmin({ realm: [REALM_ROLES[0], REALM_ROLES[2]], client: [] })
    const res = await put({ realmRoles: ['default-roles-test', 'admin'] })
    expect(res.status).toBe(200)
    expect(current.log).toEqual(['realm-del:user', 'realm-add:admin'])
  })

  it('leaves realm roles alone when the request names the roles the user already holds', async () => {
    current = fakeAdmin({ realm: [REALM_ROLES[0]], client: [] })
    expect((await put({ realmRoles: ['user'] })).status).toBe(200)
    expect(current.log).toEqual([])
  })

  it('replaces the roles of one client', async () => {
    current = fakeAdmin({ realm: [], client: [CLIENT_ROLES[0]] })
    expect((await put({ clientRoles: { 'admin-ui': ['practitioner'] } })).status).toBe(200)
    expect(current.log).toEqual(['client-del:admin', 'client-add:practitioner'])
  })

  it('reports a failed role write instead of answering 200', async () => {
    current = fakeAdmin({ realm: [], client: [] }, true)
    const res = await put({ realmRoles: ['admin'] })
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})
