// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { mockLoggerModule } from './helpers/mock-logger'
import { mockKcAdminFactory } from './helpers/keycloak-admin'
import { TEST_BASE_URL, omitTestEnv, useTestEnv } from './helpers/test-env'

mockLoggerModule()

let createCalls: unknown[] = []

class UnreadableRealmAdmin {
  realms = {
    findOne: async () => {
      throw Object.assign(new Error('forbidden'), { response: { status: 403 } })
    },
  }
  clients = {
    create: async (payload: unknown) => {
      createCalls.push(payload)
      return { id: 'created-client-uuid' }
    },
    find: async () => [],
    getClientSecret: async () => ({ value: 'secret' }),
    addDefaultClientScope: async () => {},
    addOptionalClientScope: async () => {},
  }
  clientScopes = { find: async () => [] }
  auth = async () => {}
  setConfig = () => {}
}

mock.module('@keycloak/keycloak-admin-client', () => ({ default: UnreadableRealmAdmin }))
mockKcAdminFactory(async () => new UnreadableRealmAdmin())
mock.module('@/lib/cors-origins', () => ({ refreshCorsOrigins: async () => {} }))

const { clientRegistrationRoutes } = await import('../src/routes/auth/client-registration')
const app = new Elysia({ prefix: '/auth' }).use(clientRegistrationRoutes)

describe('dynamic client registration with unreadable settings', () => {
  useTestEnv(omitTestEnv('KEYCLOAK_PUBLIC_URL', 'SMART_LAUNCH_SECRET', 'FHIR_BASE_URL', 'PROXY_NAME'))

  beforeEach(() => {
    createCalls = []
  })

  it('registers nothing when the realm settings cannot be read', async () => {
    const res = await app.handle(new Request(`${TEST_BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost:3000/callback'], client_name: 'probe' }),
    }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(createCalls.length).toBe(0)
  })
})
