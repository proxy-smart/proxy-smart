// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Backend-service registration defects that each return 200 yet leave the client unable to get a token.
import { describe, it, expect, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { CreateSmartAppRequest, UpdateSmartAppRequest } from '../src/schemas/admin/smart-apps'
import { toKeycloakAuthType } from '../src/lib/auth-method-mapping'
import { isRecord, stringArray } from '../src/lib/type-guards'
import { fakeKcAdmin } from './helpers/keycloak-admin'
import { schemaProperties } from './helpers/tool-schema'

mock.module('../src/lib/auth', () => ({
  validateToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
  validateAdminToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
}))

const REALM_SCOPES = ['openid', 'profile', 'resource-indicators', 'system/Person.c', 'system/Patient.c', 'system/Consent.c']
  .map((name) => ({ id: `scope-${name}`, name }))
const kc = fakeKcAdmin({
  realmScopes: REALM_SCOPES,
  clients: [{ id: 'existing-svc-id', clientId: 'existing-svc', protocol: 'openid-connect', serviceAccountsEnabled: true }],
})

mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async () => kc.admin),
}))

const { smartAppsRoutes } = await import('../src/routes/admin/smart-apps')

/** Whether a TypeBox schema accepts a property at all (Elysia strips undeclared ones). */
function declares(schema: unknown, field: string): boolean {
  return Object.keys(schemaProperties(schema)).includes(field)
}

describe('private_key_jwt maps to assertion auth, not a shared secret', () => {
  it('resolves to federated-jwt', () => {
    expect(toKeycloakAuthType('private_key_jwt', true)).toBe('federated-jwt')
    expect(toKeycloakAuthType('private_key_jwt', false)).toBe('federated-jwt')
  })

  it('keeps client-secret for the methods that use one', () => {
    expect(toKeycloakAuthType('client_secret_post', true)).toBe('client-secret')
    expect(toKeycloakAuthType('client_secret_basic', false)).toBe('client-secret')
    expect(toKeycloakAuthType('none', false)).toBe('none')
  })
})

describe('the signing algorithm is statable', () => {
  it('is accepted on create and update', () => {
    expect(declares(CreateSmartAppRequest, 'tokenEndpointAuthSigningAlg')).toBe(true)
    expect(declares(UpdateSmartAppRequest, 'tokenEndpointAuthSigningAlg')).toBe(true)
  })

  it('offers both algorithm families SMART Backend Services allows', () => {
    const field = schemaProperties(CreateSmartAppRequest).tokenEndpointAuthSigningAlg
    const algorithms = isRecord(field) ? stringArray(field.enum) : undefined
    expect(algorithms).toContain('RS384')
    expect(algorithms).toContain('ES384')
  })
})

describe('systemScopes is not silently dropped', () => {
  it('is declared on create and update', () => {
    expect(declares(CreateSmartAppRequest, 'systemScopes')).toBe(true)
    expect(declares(UpdateSmartAppRequest, 'systemScopes')).toBe(true)
  })

  it('is attached on create, merged with optional scopes and de-duplicated', async () => {
    const response = await new Elysia().use(smartAppsRoutes).handle(new Request('http://localhost/smart-apps', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'backend-svc',
        name: 'Backend service',
        appType: 'backend-service',
        clientType: 'backend-service',
        jwksUri: 'https://svc.example.com/jwks.json',
        optionalClientScopes: ['system/Person.c', 'system/Patient.c'],
        systemScopes: ['system/Patient.c', 'system/Consent.c'],
      }),
    }))

    expect(response.status).toBe(200)
    expect(kc.optionalScopeNames()).toEqual(['system/Person.c', 'system/Patient.c', 'system/Consent.c'])
  })

  it('is attached on update when it is the only scope field sent', async () => {
    const before = kc.optionalScopes.length
    const response = await new Elysia().use(smartAppsRoutes).handle(new Request('http://localhost/smart-apps/existing-svc', {
      method: 'PUT',
      headers: { Authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ systemScopes: ['system/Consent.c'] }),
    }))

    expect(response.status).toBe(200)
    expect(kc.optionalScopeNames().slice(before)).toEqual(['system/Consent.c'])
  })
})

describe('optional request fields carry no injected default', () => {
  const OPTIONAL_ENUMS = [
    'appType',
    'clientType',
    'tokenEndpointAuthMethod',
    'serverAccessType',
    'tokenEndpointAuthSigningAlg',
  ]

  for (const [name, schema] of Object.entries({ create: CreateSmartAppRequest, update: UpdateSmartAppRequest })) {
    it(`${name}: omitting a field means omitted`, () => {
      const properties = schemaProperties(schema)
      const withDefaults = OPTIONAL_ENUMS.filter((field) => {
        const property = properties[field]
        return isRecord(property) && property.default !== undefined
      })

      expect(withDefaults).toEqual([])
    })
  }
})
