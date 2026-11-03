// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock } from 'bun:test'
import { Elysia } from 'elysia'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import { isRecord } from '../src/lib/type-guards'

const PROVIDERS = [{ alias: 'google', providerId: 'google', enabled: true, config: { clientId: 'x' } }]

const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
admin.identityProviders.findOne = async (query) => PROVIDERS.find((p) => p.alias === query?.alias)

mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async () => admin),
}))

const { identityProvidersRoutes } = await import('../src/routes/admin/identity-providers')
const app = new Elysia({ prefix: '/admin' }).use(identityProvidersRoutes)

async function testConnection(alias: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/admin/idps/${alias}/test-connection`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  const parsed: unknown = await res.json()
  return { status: res.status, body: parsed }
}

describe('POST /admin/idps/:alias/test-connection', () => {
  it('answers 404 for an unknown provider', async () => {
    expect((await testConnection('missing')).status).toBe(404)
  })

  it('tests the stored provider and ignores URLs sent with the request', async () => {
    const { status, body } = await testConnection('google', { config: { issuer: 'http://169.254.169.254' } })
    expect(status).toBe(200)
    expect(isRecord(body) ? [body.alias, body.status, body.checks] : null).toEqual(['google', 'untested', []])
  })
})
