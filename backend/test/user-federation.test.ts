// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type ComponentRepresentation from '@keycloak/keycloak-admin-client/lib/defs/componentRepresentation.js'
import { isRecord } from '../src/lib/type-guards'

const PROVIDER_TYPE = 'org.keycloak.storage.UserStorageProvider'
const MAPPER_TYPE = 'org.keycloak.storage.ldap.mappers.LDAPStorageMapper'

const LDAP: ComponentRepresentation = {
  id: 'ldap-1',
  name: 'Corporate LDAP',
  providerId: 'ldap',
  providerType: PROVIDER_TYPE,
  parentId: 'realm-id',
  config: { connectionUrl: ['ldap://ldap.example.com:389'], bindCredential: ['stored-secret'], editMode: ['READ_ONLY'] },
}
const KEY_PROVIDER: ComponentRepresentation = { id: 'rsa-1', name: 'rsa-generated', providerId: 'rsa-generated', providerType: 'org.keycloak.keys.KeyProvider' }
const MAPPER: ComponentRepresentation = {
  id: 'mapper-1', name: 'fhirUser', providerId: 'user-attribute-ldap-mapper', providerType: MAPPER_TYPE, parentId: 'ldap-1',
  config: { 'ldap.attribute': ['fhirUser'], 'user.model.attribute': ['fhirUser'] },
}
const OTHER_MAPPER: ComponentRepresentation = { ...MAPPER, id: 'mapper-2', parentId: 'ldap-2' }

interface Calls {
  updated: { id: string; rep: ComponentRepresentation }[]
  deleted: string[]
  created: ComponentRepresentation[]
  storage: string[]
  ldapTests: Record<string, unknown>[]
}

function fakeAdmin(components: ComponentRepresentation[], ldapFails = false) {
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test-realm' })
  const calls: Calls = { updated: [], deleted: [], created: [], storage: [], ldapTests: [] }
  admin.components.find = async (query) => components.filter((c) => !query?.type || c.providerType === query.type)
  admin.components.findOne = async (query) => components.find((c) => c.id === query?.id)
  admin.components.create = async (rep) => {
    calls.created.push(rep ?? {})
    return { id: 'new-id' }
  }
  admin.components.update = async ({ id }, rep) => { calls.updated.push({ id, rep }) }
  admin.components.del = async (query) => { calls.deleted.push(query?.id ?? '') }
  admin.userStorageProvider.sync = async (query) => {
    calls.storage.push(`sync:${query?.id}`)
    return { added: 1, updated: 0, removed: 0, failed: 0, status: 'ok', ignored: false }
  }
  admin.userStorageProvider.removeImportedUsers = async (query) => { calls.storage.push(`remove-imported:${query?.id}`) }
  admin.userStorageProvider.unlinkUsers = async (query) => { calls.storage.push(`unlink:${query?.id}`) }
  admin.realms.testLDAPConnection = async (query, payload) => {
    calls.ldapTests.push({ ...query, ...payload })
    if (ldapFails) throw Object.assign(new Error('LDAP refused'), { response: { status: 400 } })
  }
  return { admin, calls }
}

let current = fakeAdmin([LDAP, KEY_PROVIDER, MAPPER, OTHER_MAPPER])

mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async () => current.admin),
}))

const { userFederationRoutes } = await import('../src/routes/admin/user-federation')
const { userFederationMapperRoutes } = await import('../src/routes/admin/user-federation-mappers')

const app = new Elysia().use(userFederationRoutes).use(userFederationMapperRoutes)

async function call(method: string, path: string, body?: unknown, token: string | null = 'tok') {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await app.handle(new Request(`http://localhost/user-federation${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  const parsed: unknown = await res.json()
  return { status: res.status, body: parsed }
}

const field = (body: unknown, key: string): unknown => (isRecord(body) ? body[key] : undefined)

beforeEach(() => {
  current = fakeAdmin([LDAP, KEY_PROVIDER, MAPPER, OTHER_MAPPER])
})

describe('user federation providers', () => {
  it('refuses a request without a bearer token', async () => {
    const { status } = await call('GET', '/', undefined, null)
    expect(status).toBe(401)
  })

  it('lists only LDAP providers and masks the bind credential', async () => {
    const { status, body } = await call('GET', '/')
    expect(status).toBe(200)
    expect(Array.isArray(body) && body.map((p) => field(p, 'id'))).toEqual(['ldap-1'])
    expect(JSON.stringify(body)).not.toContain('stored-secret')
  })

  it('counts LDAP providers among all user storage providers', async () => {
    const { body } = await call('GET', '/count')
    expect(body).toEqual({ count: 1, total: 1 })
  })

  it('creates the provider as an LDAP user storage component', async () => {
    const { status } = await call('POST', '/', { name: 'New', config: { connectionUrl: 'ldap://x', usersDn: 'ou=x', startTls: true } })
    expect(status).toBe(200)
    expect(current.calls.created[0]).toMatchObject({
      providerId: 'ldap',
      providerType: PROVIDER_TYPE,
      config: { connectionUrl: ['ldap://x'], usersDn: ['ou=x'], startTls: ['true'] },
    })
  })

  it.each([
    ['GET', '/rsa-1', undefined],
    ['PUT', '/rsa-1', { name: 'renamed' }],
    ['DELETE', '/rsa-1', undefined],
    ['POST', '/rsa-1/sync', { action: 'triggerFullSync' }],
    ['POST', '/rsa-1/remove-imported', undefined],
    ['POST', '/rsa-1/unlink', undefined],
    ['DELETE', '/missing', undefined],
  ])('answers %s %s with 404 when the id is not a user storage provider', async (method, path, body) => {
    const { status } = await call(method, path, body)
    expect(status).toBe(404)
    expect(current.calls.deleted).toEqual([])
    expect(current.calls.updated).toEqual([])
    expect(current.calls.storage).toEqual([])
  })

  it('deletes, syncs, removes imported users and unlinks a real provider', async () => {
    expect((await call('POST', '/ldap-1/sync', { action: 'triggerChangedUsersSync' })).status).toBe(200)
    expect((await call('POST', '/ldap-1/remove-imported')).status).toBe(200)
    expect((await call('POST', '/ldap-1/unlink')).status).toBe(200)
    expect((await call('DELETE', '/ldap-1')).status).toBe(200)
    expect(current.calls.storage).toEqual(['sync:ldap-1', 'remove-imported:ldap-1', 'unlink:ldap-1'])
    expect(current.calls.deleted).toEqual(['ldap-1'])
  })

  it('keeps the stored config when an update only renames', async () => {
    await call('PUT', '/ldap-1', { name: 'Renamed' })
    expect(current.calls.updated).toEqual([{ id: 'ldap-1', rep: { ...LDAP, name: 'Renamed' } }])
  })
})

describe('LDAP connection tests', () => {
  const payload = { connectionUrl: 'ldap://host:389', bindDn: 'cn=user', bindCredential: 'pass' }

  it.each([
    ['/test-connection', 'testConnection'],
    ['/test-authentication', 'testAuthentication'],
  ])('%s runs %s against the client realm', async (path, action) => {
    const { status, body } = await call('POST', path, payload)
    expect(status).toBe(200)
    expect(field(body, 'success')).toBe(true)
    expect(current.calls.ldapTests).toEqual([{
      realm: 'test-realm', action, ...payload, useTruststoreSpi: 'ldapsOnly', authType: 'simple',
      connectionTimeout: undefined, startTls: undefined,
    }])
  })

  it.each(['/test-connection', '/test-authentication'])('%s reports a refused bind as a 400 error body', async (path) => {
    current = fakeAdmin([LDAP], true)
    const { status, body } = await call('POST', path, payload)
    expect(status).toBe(400)
    expect(typeof field(body, 'error')).toBe('string')
  })
})

describe('LDAP mappers', () => {
  it('lists the mappers of a provider', async () => {
    const { status, body } = await call('GET', '/ldap-1/mappers')
    expect(status).toBe(200)
    expect(Array.isArray(body) && body.map((m) => field(m, 'id'))).toEqual(['mapper-1', 'mapper-2'])
  })

  it.each(['/rsa-1/mappers', '/unknown/mappers', '/unknown/mapper-types'])('answers %s with 404 when no such provider exists', async (path) => {
    const { status, body } = await call('GET', path)
    expect(status).toBe(404)
    expect(field(body, 'error')).toBe('User federation provider not found')
  })

  it('refuses to attach a mapper to a component that is not a user storage provider', async () => {
    const { status } = await call('POST', '/rsa-1/mappers', { name: 'm', providerId: 'user-attribute-ldap-mapper', config: {} })
    expect(status).toBe(404)
    expect(current.calls.created).toEqual([])
  })

  it('creates a mapper under the provider', async () => {
    const { status } = await call('POST', '/ldap-1/mappers', { name: 'm', providerId: 'user-attribute-ldap-mapper', config: { 'ldap.attribute': 'uid' } })
    expect(status).toBe(200)
    expect(current.calls.created[0]).toMatchObject({ parentId: 'ldap-1', providerType: MAPPER_TYPE, config: { 'ldap.attribute': ['uid'] } })
  })

  it('merges config into the existing mapper on update', async () => {
    const { status } = await call('PUT', '/ldap-1/mappers/mapper-1', { config: { 'ldap.attribute': 'hcFhirUser' } })
    expect(status).toBe(200)
    expect(current.calls.updated[0]?.rep.config).toEqual({ 'ldap.attribute': ['hcFhirUser'], 'user.model.attribute': ['fhirUser'] })
  })

  it.each([
    ['PUT', { name: 'x' }],
    ['DELETE', undefined],
  ])('%s refuses a mapper that belongs to another provider', async (method, body) => {
    const { status } = await call(method, '/ldap-1/mappers/mapper-2', body)
    expect(status).toBe(404)
    expect(current.calls.updated).toEqual([])
    expect(current.calls.deleted).toEqual([])
  })

  it('refuses a mapper id that names the provider itself', async () => {
    const { status } = await call('DELETE', '/realm-id/mappers/ldap-1')
    expect(status).toBe(404)
    expect(current.calls.deleted).toEqual([])
  })
})
