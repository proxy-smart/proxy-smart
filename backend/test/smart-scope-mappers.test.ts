// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type ProtocolMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/protocolMapperRepresentation.js'
import { ensureAllSmartMappers } from '../src/lib/smart-scope-mappers'

interface FakeScopes {
  listFails?: boolean
  addFails?: boolean
  existing?: ProtocolMapperRepresentation[]
}

function adminWithFhirUserScope({ listFails = false, addFails = false, existing = [] }: FakeScopes) {
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
  const added: string[] = []
  admin.clientScopes.find = async () => [{ id: 'scope-1', name: 'fhirUser' }]
  admin.clientScopes.listProtocolMappers = async () => {
    if (listFails) throw new Error('listing refused')
    return existing
  }
  admin.clientScopes.addProtocolMapper = async (_scope, mapper) => {
    if (addFails) throw new Error('create refused')
    added.push(mapper.name ?? '')
  }
  return { admin, added }
}

describe('ensureAllSmartMappers', () => {
  it('creates a missing mapper and reports no errors', async () => {
    const { admin, added } = adminWithFhirUserScope({})
    expect(await ensureAllSmartMappers(admin)).toEqual({ scanned: 1, created: 1, errors: [] })
    expect(added).toEqual(['fhirUser-mapper'])
  })

  it('skips a mapper the scope already has', async () => {
    const { admin, added } = adminWithFhirUserScope({ existing: [{ name: 'fhirUser-mapper' }] })
    expect(await ensureAllSmartMappers(admin)).toEqual({ scanned: 1, created: 0, errors: [] })
    expect(added).toEqual([])
  })

  it('reports a mapper Keycloak refused to create', async () => {
    const { admin } = adminWithFhirUserScope({ addFails: true })
    const result = await ensureAllSmartMappers(admin)
    expect(result.created).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('fhirUser-mapper')
  })

  it('reports a scope whose mappers could not be listed, without blind creates', async () => {
    const { admin, added } = adminWithFhirUserScope({ listFails: true })
    const result = await ensureAllSmartMappers(admin)
    expect(result.errors).toHaveLength(1)
    expect(added).toEqual([])
  })
})

describe('membership tier claim', () => {
  it('emits the membership_tier attribute in tokens through the default roles scope', async () => {
    const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
    const added: ProtocolMapperRepresentation[] = []
    admin.clientScopes.find = async () => [{ id: 'roles-id', name: 'roles' }, { id: 'email-id', name: 'email' }]
    admin.clientScopes.listProtocolMappers = async () => [{ name: 'realm roles' }]
    admin.clientScopes.addProtocolMapper = async (_scope, mapper) => { added.push(mapper) }

    expect(await ensureAllSmartMappers(admin)).toEqual({ scanned: 1, created: 1, errors: [] })
    expect(added[0]?.name).toBe('membership-tier-mapper')
    expect(added[0]?.config).toMatchObject({
      'user.attribute': 'membership_tier',
      'claim.name': 'membership_tier',
      'access.token.claim': 'true',
    })
  })
})
