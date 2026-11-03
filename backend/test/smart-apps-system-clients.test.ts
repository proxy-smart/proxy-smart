// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import { useTestEnv } from './helpers/test-env'

const CLIENTS = [
  { id: 'kc-realm-mgmt', clientId: 'realm-management', protocol: 'openid-connect', bearerOnly: true },
  { id: 'kc-account', clientId: 'account', protocol: 'openid-connect' },
  { id: 'kc-admin-ui', clientId: 'ops-console', protocol: 'openid-connect' },
  { id: 'kc-bearer', clientId: 'legacy-api', protocol: 'openid-connect', bearerOnly: true },
  { id: 'kc-saml', clientId: 'saml-sp', protocol: 'saml' },
  { id: 'kc-app', clientId: 'patient-portal', protocol: 'openid-connect' },
  { id: 'kc-dcr', clientId: 'smart_app_0b6f', protocol: 'openid-connect', publicClient: true },
  { id: 'kc-resource', clientId: 'fhir-resource-server', protocol: 'openid-connect', standardFlowEnabled: false },
]

useTestEnv({ KEYCLOAK_ADMIN_UI_CLIENT_ID: 'ops-console' })

const calls: string[] = []

mock.module('../src/lib/auth', () => ({
  validateToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
  validateAdminToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
}))

const fakeAdmin = {
  clients: {
    find: async ({ clientId }: { clientId?: string } = {}) => CLIENTS.filter(c => clientId === undefined || c.clientId === clientId),
    findOne: async ({ id }: { id: string }) => CLIENTS.find(c => c.id === id) ?? null,
    update: async ({ id }: { id: string }) => { calls.push(`update:${id}`) },
    del: async ({ id }: { id: string }) => { calls.push(`del:${id}`) },
    listDefaultClientScopes: async () => [],
    listOptionalClientScopes: async () => [],
    listProtocolMappers: async ({ id }: { id: string }) => { calls.push(`mappers:${id}`); return [] },
    addProtocolMapper: async ({ id }: { id: string }) => { calls.push(`addMapper:${id}`) },
    updateProtocolMapper: async ({ id }: { id: string }) => { calls.push(`updateMapper:${id}`) },
    delProtocolMapper: async ({ id }: { id: string }) => { calls.push(`delMapper:${id}`) },
    getServiceAccountUser: async () => undefined,
  },
}

mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async () => fakeAdmin),
}))

const { smartAppsRoutes } = await import('../src/routes/admin/smart-apps')
const { smartAppMapperRoutes } = await import('../src/routes/admin/smart-app-mappers')
const app = new Elysia().use(smartAppsRoutes).use(smartAppMapperRoutes)

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: 'Bearer token', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }))
}

const SYSTEM_CLIENTS = ['realm-management', 'account', 'ops-console', 'legacy-api', 'saml-sp']
const MAPPER = { name: 'm', protocolMapper: 'oidc-hardcoded-claim-mapper', config: {} }

beforeEach(() => { calls.length = 0 })

describe('/smart-apps/:clientId addresses only realm apps', () => {
  for (const clientId of SYSTEM_CLIENTS) {
    it(`answers 404 for ${clientId} and leaves it untouched`, async () => {
      const responses = await Promise.all([
        send('GET', `/smart-apps/${clientId}`),
        send('PUT', `/smart-apps/${clientId}`, { name: 'renamed' }),
        send('DELETE', `/smart-apps/${clientId}`),
        send('GET', `/smart-apps/${clientId}/mappers`),
        send('POST', `/smart-apps/${clientId}/mappers`, MAPPER),
        send('POST', `/smart-apps/${clientId}/mappers/audience`, { audience: 'fhir-resource-server' }),
        send('PUT', `/smart-apps/${clientId}/mappers/mapper-1`, MAPPER),
        send('DELETE', `/smart-apps/${clientId}/mappers/mapper-1`),
      ])
      expect(responses.map(response => response.status)).toEqual(Array(responses.length).fill(404))
      expect(calls).toEqual([])
    })
  }

  for (const clientId of ['patient-portal', 'smart_app_0b6f', 'fhir-resource-server']) {
    it(`still serves ${clientId}`, async () => {
      expect((await send('GET', `/smart-apps/${clientId}`)).status).toBe(200)
      expect((await send('GET', `/smart-apps/${clientId}/mappers`)).status).toBe(200)
      expect((await send('DELETE', `/smart-apps/${clientId}`)).status).toBe(200)
    })
  }

  it('lists the same clients it serves', async () => {
    const listed: { clientId: string }[] = await (await send('GET', '/smart-apps/')).json()
    expect(listed.map(app => app.clientId).sort()).toEqual(['fhir-resource-server', 'patient-portal', 'smart_app_0b6f'])
  })
})
