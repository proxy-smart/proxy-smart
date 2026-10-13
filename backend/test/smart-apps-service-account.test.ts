// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock } from 'bun:test'
import { Elysia } from 'elysia'

const CLIENTS = [
  { id: 'internal-svc', clientId: 'admin-service', protocol: 'openid-connect', serviceAccountsEnabled: true },
  { id: 'internal-web', clientId: 'web-app', protocol: 'openid-connect', serviceAccountsEnabled: false },
]

mock.module('../src/lib/auth', () => ({
  validateToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
  validateAdminToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
}))

const fakeAdmin = {
  clients: {
    find: async ({ clientId }: { clientId: string }) => CLIENTS.filter(c => c.clientId === clientId),
    findOne: async ({ id }: { id: string }) => CLIENTS.find(c => c.id === id) ?? null,
    listDefaultClientScopes: async () => [],
    listOptionalClientScopes: async () => [],
    getServiceAccountUser: async ({ id }: { id: string }) => ({ id: `user-of-${id}` }),
  },
}

mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async () => fakeAdmin),
}))

const { smartAppsRoutes } = await import('../src/routes/admin/smart-apps')
const app = new Elysia().use(smartAppsRoutes)
const get = (path: string) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { Authorization: 'Bearer token' } }))

describe('GET /smart-apps/:clientId service account', () => {
  it('names the service-account user of a client that has one', async () => {
    const body = await (await get('/smart-apps/admin-service')).json()
    expect(body.serviceAccountUserId).toBe('user-of-internal-svc')
  })

  it('omits it for a client without a service account', async () => {
    const body = await (await get('/smart-apps/web-app')).json()
    expect(body).not.toHaveProperty('serviceAccountUserId')
  })
})
