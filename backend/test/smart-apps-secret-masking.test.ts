// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock } from 'bun:test'
import { Elysia } from 'elysia'

const SECRET = 'stored-client-secret'

const confidentialClient = {
  id: 'internal-id',
  clientId: 'demo-app',
  protocol: 'openid-connect',
  enabled: true,
  publicClient: false,
  secret: SECRET,
}

mock.module('../src/lib/auth', () => ({
  validateToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
  validateAdminToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
}))

const fakeAdmin = {
  clients: {
    find: async () => [confidentialClient],
    findOne: async () => { throw new Error('Keycloak is throttling') },
  },
}

mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async () => fakeAdmin),
}))

const { smartAppsRoutes } = await import('../src/routes/admin/smart-apps')
const { maskClientSecret, MASKED_SECRET } = await import('../src/lib/secret-mask')

const app = new Elysia().use(smartAppsRoutes)
const get = (path: string) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { Authorization: 'Bearer token' } }))

describe('maskClientSecret', () => {
  it('replaces a set secret and leaves a client without one untouched', () => {
    const confidential: { clientId: string; secret?: string } = { clientId: 'a', secret: SECRET }
    const publicClient: { clientId: string; secret?: string } = { clientId: 'b' }
    expect(maskClientSecret(confidential)).toEqual({ clientId: 'a', secret: MASKED_SECRET })
    expect(maskClientSecret(publicClient)).toEqual({ clientId: 'b' })
  })
})

describe('SMART app reads when enrichment fails', () => {
  it('lists apps without the stored client secret', async () => {
    const res = await get('/smart-apps')
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain(SECRET)
    expect(JSON.parse(raw)[0].secret).toBe(MASKED_SECRET)
  })

  it('returns one app without the stored client secret', async () => {
    const res = await get('/smart-apps/demo-app')
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain(SECRET)
    expect(JSON.parse(raw).secret).toBe(MASKED_SECRET)
  })
})
