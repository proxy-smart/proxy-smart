// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { AuthorizationError } from '../src/lib/admin-utils'
import type { AdminAccess } from '../src/lib/admin-roles'

const auditorAdmin = {
  identityProviders: {
    find: async () => [],
    findOne: async () => ({ alias: 'corp', providerId: 'oidc' }),
    findMappers: async () => [],
    findMapperTypes: async () => ({}),
  },
  components: {
    findOne: async () => ({ id: 'ldap-1', providerType: 'org.keycloak.storage.UserStorageProvider' }),
    find: async () => [],
    listSubComponents: async () => [],
  },
  clients: {
    find: async () => [{ id: 'kc-app', clientId: 'patient-portal', protocol: 'openid-connect' }],
    listProtocolMappers: async () => [],
  },
}

let grantedAccess: AdminAccess | null = 'read'

mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async (_token: string, access: AdminAccess = 'write') => {
    if (grantedAccess === null || (grantedAccess === 'read' && access === 'write')) {
      throw new AuthorizationError('User does not have admin permissions')
    }
    return auditorAdmin
  }),
}))

const { organizationsRoutes } = await import('../src/routes/admin/organizations')
const { healthcareUsersRoutes } = await import('../src/routes/admin/healthcare-users')
const { identityProviderMapperRoutes } = await import('../src/routes/admin/identity-provider-mappers')
const { userFederationMapperRoutes } = await import('../src/routes/admin/user-federation-mappers')
const { smartAppMapperRoutes } = await import('../src/routes/admin/smart-app-mappers')

const app = new Elysia()
  .use(organizationsRoutes)
  .use(healthcareUsersRoutes)
  .use(identityProviderMapperRoutes)
  .use(userFederationMapperRoutes)
  .use(smartAppMapperRoutes)

const get = (path: string, token: string | null = 'tok') =>
  app.handle(new Request(`http://localhost${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }))

describe('admin client acquisition', () => {
  it.each(['/organizations/', '/healthcare-users/'])('reports an insufficient grant on %s as 403', async (path) => {
    grantedAccess = null
    const res = await get(path)
    expect(res.status).toBe(403)
  })

  it.each([
    '/idps/mapper-status',
    '/idps/corp/mapper-status',
    '/idps/corp/mappers',
    '/idps/corp/mapper-types',
    '/user-federation/ldap-1/mappers',
    '/user-federation/ldap-1/mapper-types',
    '/smart-apps/patient-portal/mappers',
  ])(
    'lets a read-only caller read %s, which the admin guard admits for auditors',
    async (path) => {
      grantedAccess = 'read'
      const res = await get(path)
      expect(res.status).toBe(200)
    }
  )

  it('rejects a request without a bearer token as 401', async () => {
    grantedAccess = 'write'
    const res = await get('/idps/corp/mappers', null)
    expect(res.status).toBe(401)
  })

  it('still needs write access to change a mapper', async () => {
    grantedAccess = 'read'
    const res = await app.handle(new Request('http://localhost/smart-apps/patient-portal/mappers/m-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok' },
    }))
    expect(res.status).toBe(403)
  })
})
