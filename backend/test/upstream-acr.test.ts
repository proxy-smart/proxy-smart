// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderMapperRepresentation.js'
import type IdentityProviderRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderRepresentation.js'
import type ProtocolMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/protocolMapperRepresentation'
import {
  UPSTREAM_ACR_CLAIM,
  ensureUpstreamAcrClaim,
  ensureUpstreamAcrSessionNotes,
  ensureUpstreamAcrValuesAdvertised,
  upstreamAcrIdpMapper,
} from '../src/lib/upstream-acr'

interface Fake {
  admin: KcAdminClient
  createdIdpMappers: IdentityProviderMapperRepresentation[]
  addedProtocolMappers: ProtocolMapperRepresentation[]
  realmUpdates: { attributes?: Record<string, unknown> }[]
}

function fakeAdmin(opts: {
  providers?: IdentityProviderRepresentation[]
  idpMappers?: Record<string, IdentityProviderMapperRepresentation[]>
  scopes?: { id: string; name: string }[]
  scopeMappers?: ProtocolMapperRepresentation[]
  realmAttributes?: Record<string, string>
}): Fake {
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
  const fake: Fake = { admin, createdIdpMappers: [], addedProtocolMappers: [], realmUpdates: [] }
  admin.identityProviders.find = async () => opts.providers ?? []
  admin.identityProviders.findMappers = async (q) => (q ? opts.idpMappers?.[q.alias] : undefined) ?? []
  admin.identityProviders.createMapper = async (q) => { if (q) fake.createdIdpMappers.push(q.identityProviderMapper); return { id: 'm1' } }
  admin.clientScopes.find = async () => opts.scopes ?? []
  admin.clientScopes.listProtocolMappers = async () => opts.scopeMappers ?? []
  admin.clientScopes.addProtocolMapper = async (_q, mapper) => { fake.addedProtocolMappers.push(mapper) }
  admin.realms.findOne = async () => ({ realm: 'test', attributes: opts.realmAttributes ?? {} })
  admin.realms.update = async (_q, realm) => { fake.realmUpdates.push(realm) }
  return fake
}

describe('upstream acr session notes', () => {
  it('copies the acr of every user-facing OIDC provider into the user session, refreshed on each sign-in', async () => {
    const fake = fakeAdmin({
      providers: [
        { alias: 'maxhealth', providerId: 'oidc' },
        { alias: 'partner-kc', providerId: 'keycloak-oidc' },
        { alias: 'hospital-saml', providerId: 'saml' },
        { alias: 'proxy-signing', providerId: 'oidc', config: { supportsClientAssertions: 'true' } },
      ],
    })
    expect(await ensureUpstreamAcrSessionNotes(fake.admin)).toEqual(['maxhealth', 'partner-kc'])
    expect(fake.createdIdpMappers[0]).toEqual(upstreamAcrIdpMapper('maxhealth'))
    expect(fake.createdIdpMappers[0].config).toMatchObject({ syncMode: 'FORCE', 'are.claim.values.regex': 'true' })
    expect(JSON.parse(String(fake.createdIdpMappers[0].config?.claims))).toEqual([{ key: 'acr', value: '.+' }])
  })

  it('leaves a provider alone that already copies its acr, whatever the mapper is called', async () => {
    const existing = { ...upstreamAcrIdpMapper('maxhealth'), name: 'renamed by an admin' }
    const fake = fakeAdmin({ providers: [{ alias: 'maxhealth', providerId: 'oidc' }], idpMappers: { maxhealth: [existing] } })
    expect(await ensureUpstreamAcrSessionNotes(fake.admin)).toEqual([])
    expect(fake.createdIdpMappers).toEqual([])
  })
})

describe('the upstream_acr claim', () => {
  let fake: Fake
  beforeEach(() => {
    fake = fakeAdmin({ scopes: [{ id: 's-profile', name: 'profile' }, { id: 's-acr', name: 'acr' }] })
  })

  it('is emitted from the session note by the acr scope every client carries', async () => {
    expect(await ensureUpstreamAcrClaim(fake.admin)).toBe('created')
    expect(fake.addedProtocolMappers[0]).toMatchObject({
      protocolMapper: 'oidc-usersessionmodel-note-mapper',
      config: { 'user.session.note': 'acr', 'claim.name': UPSTREAM_ACR_CLAIM, 'access.token.claim': 'true', 'id.token.claim': 'true' },
    })
  })

  it('is never written as acr, which Keycloak derives from the local level of authentication', async () => {
    await ensureUpstreamAcrClaim(fake.admin)
    expect(fake.addedProtocolMappers[0].config?.['claim.name']).not.toBe('acr')
  })

  it('is added once', async () => {
    const present = fakeAdmin({ scopes: [{ id: 's-acr', name: 'acr' }], scopeMappers: [{ name: 'upstream-acr' }] })
    expect(await ensureUpstreamAcrClaim(present.admin)).toBe('present')
    expect(present.addedProtocolMappers).toEqual([])
  })

  it('reports a realm without the acr scope instead of creating one', async () => {
    expect(await ensureUpstreamAcrClaim(fakeAdmin({ scopes: [] }).admin)).toBe('no-acr-scope')
  })
})

describe('advertised upstream acr values', () => {
  it('maps each to a level no local flow reaches, keeping the levels an admin set', async () => {
    const fake = fakeAdmin({ realmAttributes: { 'acr.loa.map': '{"silver":1,"gold":2}', frontendUrl: 'https://kc' } })
    expect(await ensureUpstreamAcrValuesAdvertised(fake.admin, ['phr', 'gold'])).toEqual(['phr'])
    const attributes = fake.realmUpdates[0].attributes ?? {}
    expect(JSON.parse(String(attributes['acr.loa.map']))).toEqual({ silver: 1, gold: 2, phr: 100 })
    expect(attributes.frontendUrl).toBe('https://kc')
  })

  it('writes nothing when every value is already mapped or none is configured', async () => {
    const fake = fakeAdmin({ realmAttributes: { 'acr.loa.map': '{"phr":100}' } })
    expect(await ensureUpstreamAcrValuesAdvertised(fake.admin, ['phr'])).toEqual([])
    expect(await ensureUpstreamAcrValuesAdvertised(fake.admin, [])).toEqual([])
    expect(fake.realmUpdates).toEqual([])
  })
})
