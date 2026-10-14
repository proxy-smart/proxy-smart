// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { readKeycloakClaims } from '../src/lib/jwt-claims'

describe('readKeycloakClaims', () => {
  it('keeps well-formed Keycloak claims', () => {
    const claims = readKeycloakClaims({
      sub: 'u1',
      preferred_username: 'alice',
      realm_access: { roles: ['admin'] },
      resource_access: { 'admin-ui': { roles: ['auditor'] } },
    })

    expect(claims.sub).toBe('u1')
    expect(claims.preferred_username).toBe('alice')
    expect(claims.realm_access?.roles).toEqual(['admin'])
    expect(claims.resource_access?.['admin-ui']?.roles).toEqual(['auditor'])
  })

  it('reads malformed claims as absent so no role can be smuggled in by shape', () => {
    const claims = readKeycloakClaims({
      preferred_username: 42,
      realm_access: { roles: 'admin' },
      resource_access: { 'admin-ui': 'admin', 'realm-management': { roles: ['view-users', 7] } },
    })

    expect(claims.preferred_username).toBeUndefined()
    expect(claims.realm_access).toBeUndefined()
    expect(claims.resource_access).toEqual({ 'realm-management': { roles: ['view-users'] } })
  })
})
