// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The admin-client factory against a fake Keycloak, driving the real npm client
 * so the assertions cover how it uses a registered TokenProvider.
 *
 * Token requests are the thing counted: one per lifetime, not one per call.
 */

import { describe, it, expect } from 'bun:test'
import { createAdminClientFactory, type AdminConnection } from '../src/lib/kc-admin-factory'

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

const accessToken = (subject: string) => [
  b64url({ alg: 'RS256', typ: 'JWT' }),
  b64url({ sub: subject, exp: Math.floor(Date.now() / 1000) + 300 }),
  'signature',
].join('.')

interface Fake {
  connection: AdminConnection
  /** client_credentials requests served. */
  tokenRequests: number
  /** Authorization headers seen on admin API calls. */
  authHeaders: string[]
}

/** A fake Keycloak, stopped when the body returns. */
async function withKeycloak(
  options: { expiresIn?: number; rejectSecret?: string },
  body: (fake: Fake) => Promise<void>,
): Promise<void> {
  const state = { tokenRequests: 0, authHeaders: [] as string[] }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)

      if (pathname.endsWith('/protocol/openid-connect/token')) {
        const form = new URLSearchParams(await req.text())
        if (options.rejectSecret && form.get('client_secret') === options.rejectSecret) {
          return new Response('{"error":"invalid_client"}', { status: 401 })
        }
        state.tokenRequests++
        return Response.json({
          access_token: accessToken(form.get('client_id') ?? 'unknown'),
          expires_in: options.expiresIn ?? 300,
          token_type: 'Bearer',
          // No refresh_token, exactly as Keycloak answers this grant.
        })
      }

      if (pathname.includes('/clients')) {
        state.authHeaders.push(req.headers.get('authorization') ?? '')
        return Response.json([{ id: 'uuid-1', clientId: 'patient-portal' }])
      }

      return new Response('not found', { status: 404 })
    },
  })

  try {
    await body({
      connection: {
        baseUrl: `http://localhost:${server.port}`,
        realm: 'proxy-smart',
        adminClientId: 'admin-service',
        adminClientSecret: 'admin-service-secret',
      },
      get tokenRequests() { return state.tokenRequests },
      get authHeaders() { return state.authHeaders },
    })
  } finally {
    server.stop(true)
  }
}

describe('createAdminClientFactory', () => {
  it('authenticates once for many callers', async () => {
    await withKeycloak({}, async (fake) => {
      const factory = createAdminClientFactory(() => fake.connection)

      for (let i = 0; i < 5; i++) {
        expect(await factory.getClient()).not.toBeNull()
      }

      expect(fake.tokenRequests).toBe(1)
    })
  })

  it('hands back the same client rather than building one per call', async () => {
    await withKeycloak({}, async (fake) => {
      const factory = createAdminClientFactory(() => fake.connection)

      expect(await factory.getClient()).toBe(await factory.getClient())
    })
  })

  it('authorizes admin calls from the cached token, without a refresh', async () => {
    await withKeycloak({}, async (fake) => {
      const factory = createAdminClientFactory(() => fake.connection)
      const admin = await factory.getClient()

      await admin!.clients.find({ clientId: 'patient-portal' })
      await admin!.clients.find({ clientId: 'patient-portal' })

      expect(fake.authHeaders).toHaveLength(2)
      for (const header of fake.authHeaders) {
        expect(header.startsWith('Bearer ')).toBe(true)
      }
      // Two admin calls, still one token.
      expect(fake.tokenRequests).toBe(1)
    })
  })

  it('re-authenticates once the token is near expiry', async () => {
    // Below the safety margin, so TokenCache floors the lifetime at one second.
    await withKeycloak({ expiresIn: 1 }, async (fake) => {
      const factory = createAdminClientFactory(() => fake.connection)

      await factory.getClient()
      expect(fake.tokenRequests).toBe(1)

      await Bun.sleep(1100)
      await factory.getClient()

      expect(fake.tokenRequests).toBe(2)
    })
  })

  it('builds a new client when the deployment it points at changes', async () => {
    await withKeycloak({}, async (fake) => {
      let connection = fake.connection
      const factory = createAdminClientFactory(() => connection)

      const first = await factory.getClient()
      connection = { ...fake.connection, adminClientId: 'other-service' }
      const second = await factory.getClient()

      expect(second).not.toBe(first)
      expect(fake.tokenRequests).toBe(2)
    })
  })

  it('mints a fresh token after the service account gains a role', async () => {
    await withKeycloak({}, async (fake) => {
      const factory = createAdminClientFactory(() => fake.connection)
      const admin = await factory.getClient()

      // What ensureIdpManagementRole does once it has granted itself a role.
      factory.invalidateToken()
      await admin!.clients.find({ clientId: 'patient-portal' })

      expect(fake.tokenRequests).toBe(2)
    })
  })

  it('surfaces a refused credential from getClient itself', async () => {
    await withKeycloak({ rejectSecret: 'wrong-secret' }, async (fake) => {
      const factory = createAdminClientFactory(() => ({
        ...fake.connection,
        adminClientSecret: 'wrong-secret',
      }))

      await expect(factory.getClient()).rejects.toThrow(/401/)
    })
  })

  it('returns null, and asks for no token, when nothing is configured', async () => {
    await withKeycloak({}, async (fake) => {
      const factory = createAdminClientFactory(() => null)

      expect(await factory.getClient()).toBeNull()
      expect(fake.tokenRequests).toBe(0)
    })
  })
})
