// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation.js'
import type ClientScopeRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientScopeRepresentation.js'
import type ProtocolMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/protocolMapperRepresentation.js'
import { realmExportPaths, realmExportLabel } from './helpers/realm-exports'
import {
  INCLUDED_CLIENT_AUDIENCE,
  INCLUDED_CUSTOM_AUDIENCE,
  audienceMapper,
  audiencesOf,
  audienceKindOf,
  reconcileLiteralAudiences,
  type AudienceReconcileAdmin,
} from '../src/lib/audience-mapper'

const MCP_URL = 'https://proxy.example/mcp'

const clientAudience = (id: string, name: string, audience: string): ProtocolMapperRepresentation =>
  ({ ...audienceMapper(audience, 'client', name), id })

function fakeAdmin(clients: ClientRepresentation[], scopes: ClientScopeRepresentation[] = [], failFor?: string) {
  const updates: { owner: 'client' | 'scope'; id: string; mapperId: string; mapper: ProtocolMapperRepresentation }[] = []
  const admin: AudienceReconcileAdmin = {
    clients: {
      find: async () => clients,
      updateProtocolMapper: async ({ id, mapperId }, mapper) => {
        if (mapperId === failFor) throw new Error('kc refused')
        updates.push({ owner: 'client', id, mapperId, mapper })
      },
    },
    clientScopes: {
      find: async () => scopes,
      updateProtocolMapper: async ({ id, mapperId }, mapper) => {
        updates.push({ owner: 'scope', id, mapperId, mapper })
      },
    },
  }
  return { admin, updates }
}

describe('audience mapper helpers', () => {
  it('stores a realm client under included.client.audience and a literal under included.custom.audience', () => {
    expect(audienceMapper('fhir-resource-server', 'client', 'a').config).toMatchObject({ [INCLUDED_CLIENT_AUDIENCE]: 'fhir-resource-server' })
    const custom = audienceMapper(MCP_URL, 'custom', 'b')
    expect(custom.config).toMatchObject({ [INCLUDED_CUSTOM_AUDIENCE]: MCP_URL, 'access.token.claim': 'true', 'id.token.claim': 'false' })
    expect(custom.config[INCLUDED_CLIENT_AUDIENCE]).toBeUndefined()
  })

  it('reads audiences from both keys so a custom audience survives an admin UI round trip', () => {
    const mappers: ProtocolMapperRepresentation[] = [
      audienceMapper('mcp-resource-server', 'client', 'a'),
      audienceMapper(MCP_URL, 'custom', 'b'),
      { name: 'not-an-audience', protocolMapper: 'oidc-usermodel-attribute-mapper', config: { [INCLUDED_CUSTOM_AUDIENCE]: 'ignored' } },
    ]
    expect(audiencesOf(mappers)).toEqual(['mcp-resource-server', MCP_URL])
    expect(audienceKindOf(mappers[1])).toBe('custom')
  })
})

describe('reconcileLiteralAudiences', () => {
  it('moves a client audience that names no client to the custom key, keeping the rest of its config', async () => {
    const { admin, updates } = fakeAdmin([
      { id: 'uuid-admin-ui', clientId: 'admin-ui', protocolMappers: [clientAudience('m1', 'mcp-audience', MCP_URL)] },
    ])

    const result = await reconcileLiteralAudiences(admin)

    expect(result).toEqual([{ owner: 'admin-ui', ownerType: 'client', mapper: 'mcp-audience', audience: MCP_URL }])
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ owner: 'client', id: 'uuid-admin-ui', mapperId: 'm1' })
    expect(updates[0].mapper.config).toEqual({
      [INCLUDED_CUSTOM_AUDIENCE]: MCP_URL,
      'id.token.claim': 'false',
      'access.token.claim': 'true',
    })
  })

  it('leaves an audience naming an existing client alone, even when that client is disabled', async () => {
    const { admin, updates } = fakeAdmin([
      { id: 'uuid-app', clientId: 'app', protocolMappers: [clientAudience('m1', 'retired', 'retired-api')] },
      { id: 'uuid-retired', clientId: 'retired-api', enabled: false },
    ])

    expect(await reconcileLiteralAudiences(admin)).toEqual([])
    expect(updates).toHaveLength(0)
  })

  it('covers client-scope mappers too', async () => {
    const { admin, updates } = fakeAdmin([], [
      { id: 'scope-1', name: 'mcp', protocolMappers: [clientAudience('m2', 'mcp-aud', MCP_URL)] },
    ])

    expect(await reconcileLiteralAudiences(admin)).toEqual([{ owner: 'mcp', ownerType: 'client-scope', mapper: 'mcp-aud', audience: MCP_URL }])
    expect(updates[0]).toMatchObject({ owner: 'scope', id: 'scope-1', mapperId: 'm2' })
  })

  it('keeps going when Keycloak refuses one update and reports only what moved', async () => {
    const { admin, updates } = fakeAdmin([
      { id: 'uuid-a', clientId: 'a', protocolMappers: [clientAudience('bad', 'x', MCP_URL)] },
      { id: 'uuid-b', clientId: 'b', protocolMappers: [clientAudience('good', 'y', MCP_URL)] },
    ], [], 'bad')

    const result = await reconcileLiteralAudiences(admin)

    expect(result.map((r) => r.owner)).toEqual(['b'])
    expect(updates.map((u) => u.mapperId)).toEqual(['good'])
  })
})

interface RealmExport {
  clients?: ClientRepresentation[]
  clientScopes?: ClientScopeRepresentation[]
}

describe.each(realmExportPaths().map((path) => [realmExportLabel(path), path]))('%s audience mappers', (_label, path) => {
  const realm: RealmExport = JSON.parse(readFileSync(path, 'utf8'))
  const clientIds = new Set((realm.clients ?? []).flatMap((client) => client.clientId ?? []))
  const mappers = [
    ...(realm.clients ?? []).map((client) => ({ owner: client.clientId, protocolMappers: client.protocolMappers })),
    ...(realm.clientScopes ?? []).map((scope) => ({ owner: scope.name, protocolMappers: scope.protocolMappers })),
  ].flatMap(({ owner, protocolMappers }) => (protocolMappers ?? []).map((mapper) => ({ owner, mapper })))

  it('names only clients of this realm in included.client.audience (Keycloak 26.7.5 drops anything else)', () => {
    const dangling = mappers.flatMap(({ owner, mapper }) => {
      const audience: unknown = mapper.config?.[INCLUDED_CLIENT_AUDIENCE]
      return typeof audience === 'string' && !clientIds.has(audience) ? [`${owner}/${mapper.name}: ${audience}`] : []
    })
    expect(dangling).toEqual([])
  })
})
