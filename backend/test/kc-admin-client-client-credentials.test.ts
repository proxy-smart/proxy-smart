// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Drives the real admin client: client_credentials returns no refresh_token, which
 * 26.7.0-26.7.2 crashed on (keycloak/keycloak#50845). Every other test mocks the client.
 */
import { describe, it, expect } from 'bun:test'
import KcAdminClient from '@keycloak/keycloak-admin-client'

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const ACCESS_TOKEN = [
  b64url({ alg: 'RS256', typ: 'JWT' }),
  b64url({ sub: 'service-account', exp: Math.floor(Date.now() / 1000) + 300 }),
  'signature',
].join('.')

const REDIRECT = 'http://localhost:4567/custom/smart_stu2_2/redirect'

/** Answers exactly what Keycloak answers for client_credentials: no refresh_token. */
function startFakeKeycloak() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname.endsWith('/protocol/openid-connect/token')) {
        return Response.json({
          access_token: ACCESS_TOKEN,
          expires_in: 300,
          token_type: 'Bearer',
          'not-before-policy': 0,
          scope: 'profile email',
        })
      }
      if (pathname.includes('/clients')) {
        return Response.json([{ id: 'uuid-1', clientId: 'inferno-test-client', redirectUris: [REDIRECT] }])
      }
      return new Response('not found', { status: 404 })
    },
  })
}

describe('@keycloak/keycloak-admin-client — client_credentials without a refresh token', () => {
  it('authenticates and reads clients when the token response has no refresh_token', async () => {
    const server = startFakeKeycloak()
    try {
      const admin = new KcAdminClient({
        baseUrl: `http://localhost:${server.port}`,
        realmName: 'proxy-smart',
      })

      await admin.auth({
        grantType: 'client_credentials',
        clientId: 'admin-service',
        clientSecret: 'admin-service-secret',
      })

      const clients = await admin.clients.find({ clientId: 'inferno-test-client', max: 1 })
      expect(clients).toHaveLength(1)
      expect(clients[0].redirectUris).toEqual([REDIRECT])
    } finally {
      server.stop(true)
    }
  })
})
