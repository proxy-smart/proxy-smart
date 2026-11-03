// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { formRequest, omitTestEnv, useTestEnv } from './helpers/test-env'
import { jsonResponse, readJson, stubKeycloakEndpoint } from './helpers/fake-fetch'
import { TEST_ISSUER, mockAuthRouteModules } from './helpers/oauth-routes'

mockLoggerModule()
mockAuthRouteModules()

const DEVICE_RESPONSE = {
  device_code: 'DEV-CODE-123',
  user_code: 'ABCD-EFGH',
  verification_uri: `${TEST_ISSUER}/device`,
  verification_uri_complete: `${TEST_ISSUER}/device?user_code=ABCD-EFGH`,
  expires_in: 600,
  interval: 5,
}

const keycloak = stubKeycloakEndpoint('auth/device', () => jsonResponse(DEVICE_RESPONSE))

import { authRoutes } from '../src/routes/auth'

const requestDevice = (form: Record<string, string>) => authRoutes.handle(formRequest('/auth/device', form))

describe('POST /auth/device → KC device-authorization passthrough', () => {
  useTestEnv(omitTestEnv('KEYCLOAK_ADMIN_CLIENT_ID', 'KEYCLOAK_ADMIN_CLIENT_SECRET'))

  beforeEach(() => {
    keycloak.reset()
  })

  it('forwards the form body to KC and returns the parsed device-authorization response', async () => {
    const res = await requestDevice({ client_id: 'admin-cli', scope: 'openid profile email' })

    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual(DEVICE_RESPONSE)
    expect(keycloak.last().url).toBe(`${TEST_ISSUER}/protocol/openid-connect/auth/device`)
    expect(keycloak.last().params.get('client_id')).toBe('admin-cli')
    expect(keycloak.last().params.get('scope')).toBe('openid profile email')
  })

  it('forwards a client_secret for confidential clients', async () => {
    await requestDevice({ client_id: 'svc', client_secret: 'shh', scope: 'openid' })

    expect(keycloak.last().params.get('client_secret')).toBe('shh')
  })

  it('does not inject a resource param (no SMART session for a device grant)', async () => {
    await requestDevice({ client_id: 'admin-cli', scope: 'openid' })

    expect(keycloak.last().params.has('resource')).toBe(false)
  })

  it('sets Cache-Control: no-store on the response', async () => {
    const res = await requestDevice({ client_id: 'admin-cli' })

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })

  it('propagates the upstream status and error body when KC rejects the request', async () => {
    const refusal = { error: 'invalid_client', error_description: 'Invalid client credentials' }
    keycloak.reset(() => jsonResponse(refusal, 401))

    const res = await requestDevice({ client_id: 'bogus' })

    expect(res.status).toBe(401)
    expect(await readJson(res)).toEqual(refusal)
  })

  it('returns an RFC 6749 server_error when the upstream call throws', async () => {
    keycloak.reset(() => {
      throw new Error('network down')
    })

    const res = await requestDevice({ client_id: 'admin-cli' })

    expect(res.status).toBe(500)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await readJson(res)).error).toBe('server_error')
  })
})
