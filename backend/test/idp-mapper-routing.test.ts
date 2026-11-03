// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderMapperRepresentation.js'
import { isRecord } from '../src/lib/type-guards'

const PROVIDERS = [{ alias: 'hospital-oidc', providerId: 'oidc', enabled: true }, { alias: 'partner-saml', providerId: 'saml', enabled: true }]
const MAPPERS: IdentityProviderMapperRepresentation[] = [
  { id: 'm-1', name: 'fhirUser', identityProviderAlias: 'hospital-oidc', identityProviderMapper: 'oidc-user-attribute-idp-mapper', config: { claim: 'fhirUser' } },
  { id: 'm-2', name: 'fhirUser', identityProviderAlias: 'partner-saml', identityProviderMapper: 'saml-user-attribute-idp-mapper', config: {} },
]

function fakeAdmin() {
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
  const writes: string[] = []
  admin.identityProviders.find = async () => PROVIDERS
  admin.identityProviders.findOne = async (query) => PROVIDERS.find((p) => p.alias === query?.alias)
  admin.identityProviders.findMappers = async (query) => MAPPERS.filter((m) => m.identityProviderAlias === query?.alias)
  admin.identityProviders.findMapperTypes = async () => ({})
  admin.identityProviders.findOneMapper = async (query) => MAPPERS.find((m) => m.id === query?.id)
  admin.identityProviders.updateMapper = async (query) => { writes.push(`update:${query.alias}/${query.id}`) }
  admin.identityProviders.delMapper = async (query) => { writes.push(`delete:${query?.alias}/${query?.id}`) }
  admin.identityProviders.createMapper = async (query) => {
    writes.push(`create:${query?.alias}`)
    return { id: 'm-new' }
  }
  return { admin, writes }
}

let current = fakeAdmin()

mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async () => current.admin),
}))

const { identityProvidersRoutes } = await import('../src/routes/admin/identity-providers')
const { identityProviderMapperRoutes } = await import('../src/routes/admin/identity-provider-mappers')

const app = new Elysia({ prefix: '/admin' }).use(identityProvidersRoutes).use(identityProviderMapperRoutes)

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/admin/idps${path}`, {
    method,
    headers: { authorization: 'Bearer tok', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  const parsed: unknown = await res.json()
  return { status: res.status, body: parsed }
}

const keys = (body: unknown): string[] => (isRecord(body) ? Object.keys(body).sort() : [])

beforeEach(() => {
  current = fakeAdmin()
})

describe('identity provider mapper route precedence', () => {
  it('routes the realm-wide status to the status handler, not to GET /:alias', async () => {
    const { status, body } = await call('GET', '/mapper-status')
    expect(status).toBe(200)
    expect(keys(body)).toEqual(['definitions', 'status', 'timestamp'])
    expect(isRecord(body) && Array.isArray(body.status) ? body.status.length : -1).toBe(2)
  })

  it('still resolves a provider by alias', async () => {
    const { status, body } = await call('GET', '/hospital-oidc')
    expect(status).toBe(200)
    expect(isRecord(body) && body.alias).toBe('hospital-oidc')
  })

  it('resolves the per-provider status and mapper list', async () => {
    const status = await call('GET', '/hospital-oidc/mapper-status')
    expect(isRecord(status.body) && Array.isArray(status.body.status) ? status.body.status.length : -1).toBe(1)
    const list = await call('GET', '/hospital-oidc/mappers')
    expect(Array.isArray(list.body) && list.body.map((m) => isRecord(m) && m.id)).toEqual(['m-1'])
  })
})

describe('identity provider mapper ownership', () => {
  it('updates and deletes a mapper of the provider in the path', async () => {
    expect((await call('PUT', '/hospital-oidc/mappers/m-1', { name: 'renamed' })).status).toBe(200)
    expect((await call('DELETE', '/hospital-oidc/mappers/m-1')).status).toBe(200)
    expect(current.writes).toEqual(['update:hospital-oidc/m-1', 'delete:hospital-oidc/m-1'])
  })

  it.each([
    ['PUT', { name: 'renamed' }],
    ['DELETE', undefined],
  ])('%s refuses a mapper id that belongs to another provider', async (method, body) => {
    const { status } = await call(method, '/hospital-oidc/mappers/m-2', body)
    expect(status).toBe(404)
    expect(current.writes).toEqual([])
  })

  it('answers 404 for an unknown mapper id', async () => {
    const { status } = await call('DELETE', '/hospital-oidc/mappers/nope')
    expect(status).toBe(404)
    expect(current.writes).toEqual([])
  })
})
