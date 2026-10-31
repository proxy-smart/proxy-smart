// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Backend-service registration defects that each return 200 yet leave the client unable to get a token.
import { describe, it, expect } from 'bun:test'
import { CreateSmartAppRequest, UpdateSmartAppRequest } from '../src/schemas/admin/smart-apps'
import { toKeycloakAuthType } from '../src/lib/auth-method-mapping'

/** Whether a TypeBox schema accepts a property at all (Elysia strips undeclared ones). */
function declares(schema: { properties?: unknown }, field: string): boolean {
  return Object.prototype.hasOwnProperty.call((schema.properties ?? {}) as object, field)
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
    // A jwksUri is never fetched, so the algorithm cannot be detected for the client.
    expect(declares(CreateSmartAppRequest, 'tokenEndpointAuthSigningAlg')).toBe(true)
    expect(declares(UpdateSmartAppRequest, 'tokenEndpointAuthSigningAlg')).toBe(true)
  })

  it('offers both algorithm families SMART Backend Services allows', () => {
    const field = (CreateSmartAppRequest.properties as unknown as Record<string, { enum?: string[] }>)
      .tokenEndpointAuthSigningAlg
    expect(field.enum).toContain('RS384')
    expect(field.enum).toContain('ES384')
  })
})

describe('systemScopes is not silently dropped', () => {
  it('is declared on create and update', () => {
    expect(declares(CreateSmartAppRequest, 'systemScopes')).toBe(true)
    expect(declares(UpdateSmartAppRequest, 'systemScopes')).toBe(true)
  })

  it('merges with optional scopes and de-duplicates', () => {
    // Mirrors the route: assigning one scope twice is a Keycloak error.
    const optionalClientScopes = ['system/Person.c', 'system/Patient.c']
    const systemScopes = ['system/Patient.c', 'system/Consent.c']
    const merged = [...new Set([...optionalClientScopes, ...systemScopes])]

    expect(merged).toEqual(['system/Person.c', 'system/Patient.c', 'system/Consent.c'])
  })
})

describe('optional request fields carry no injected default', () => {
  // `t.UnionEnum` defaults to its first member and Elysia applies defaults on every request.
  const OPTIONAL_ENUMS = [
    'appType',
    'clientType',
    'tokenEndpointAuthMethod',
    'serverAccessType',
    'tokenEndpointAuthSigningAlg',
  ]

  for (const [name, schema] of [
    ['create', CreateSmartAppRequest],
    ['update', UpdateSmartAppRequest],
  ] as const) {
    it(`${name}: omitting a field means omitted`, () => {
      const properties = schema.properties as unknown as Record<string, { default?: unknown }>
      const withDefaults = OPTIONAL_ENUMS.filter((field) => properties[field]?.default !== undefined)

      expect(withDefaults).toEqual([])
    })
  }
})
