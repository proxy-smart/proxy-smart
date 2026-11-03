// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { mockKcAdminFactory } from './helpers/keycloak-admin'
import { TEST_BASE_URL, formRequest, useTestEnv } from './helpers/test-env'
import { jsonResponse, readJson, stubKeycloakEndpoint } from './helpers/fake-fetch'
import { claimsOrTestUser, mockAuthRouteModules, signRealmToken } from './helpers/oauth-routes'

const FHIR_RESOURCE = `${TEST_BASE_URL}/proxy-smart-backend/hapi-fhir-server/R4`
const DICOM_MCP = 'https://dicom.example.com/mcp'
const UNKNOWN_RESOURCE = 'https://unknown.example.com/fhir'
const DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code'
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const INVALID_TARGET = { error: 'invalid_target', error_description: 'The requested resource is invalid' }

mockLoggerModule()
mockAuthRouteModules({ validateToken: async (token) => claimsOrTestUser(token) })

let resourceClientLoads = 0
mockKcAdminFactory(async () => ({
  clients: {
    find: async () => {
      resourceClientLoads += 1
      return [
        { clientId: 'fhir-resource-server', attributes: { resource_url: FHIR_RESOURCE } },
        { clientId: DICOM_MCP, attributes: { resource_url: DICOM_MCP } },
        { clientId: 'patient-portal', attributes: {} },
      ]
    },
  },
}))

const issueToken = () => jsonResponse({
  access_token: signRealmToken({ sub: 'svc', aud: 'account' }),
  token_type: 'Bearer',
  expires_in: 300,
  scope: 'openid',
})

const keycloak = stubKeycloakEndpoint('token', issueToken)

import { authRoutes } from '../src/routes/auth'

const requestToken = (form: Record<string, string>) => authRoutes.handle(formRequest('/auth/token', form))
const forwarded = () => keycloak.last().params

const clientCredentials = (extra: Record<string, string> = {}) =>
  requestToken({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 's', ...extra })

const tokenExchange = (extra: Record<string, string>) => requestToken({
  grant_type: TOKEN_EXCHANGE,
  subject_token: 'access-token-xyz',
  subject_token_type: ACCESS_TOKEN_TYPE,
  client_id: DICOM_MCP,
  client_secret: 'sec',
  ...extra,
})

describe('Token proxy → KC forwarding', () => {
  useTestEnv()

  beforeEach(() => {
    keycloak.reset()
  })

  describe('client_credentials', () => {
    it('forwards grant_type, client_id, client_secret', async () => {
      await requestToken({ grant_type: 'client_credentials', client_id: 'admin-service', client_secret: 'the-secret' })

      expect(forwarded().get('grant_type')).toBe('client_credentials')
      expect(forwarded().get('client_id')).toBe('admin-service')
      expect(forwarded().get('client_secret')).toBe('the-secret')
    })

    it('does NOT send redirect_uri, code, code_verifier or refresh_token to KC', async () => {
      await clientCredentials()

      for (const field of ['redirect_uri', 'code', 'code_verifier', 'refresh_token']) {
        expect(forwarded().has(field)).toBe(false)
      }
    })

    it('forwards scope when provided', async () => {
      await clientCredentials({ client_id: 'backend-svc', scope: 'system/*.read' })

      expect(forwarded().get('scope')).toBe('system/*.read')
    })

    it('sends exactly the fields the client sent, plus the defaulted resource', async () => {
      await clientCredentials({ scope: 'system/*.read' })

      expect(Array.from(forwarded().keys()).sort()).toEqual(['client_id', 'client_secret', 'grant_type', 'resource', 'scope'])
    })

    it('without resource: binds the token to the FHIR server, since SMART Backend Services names none', async () => {
      await clientCredentials({ scope: 'system/Patient.rs' })

      expect(forwarded().get('resource')).toBe(FHIR_RESOURCE)
    })

    it('retries unbound when Keycloak cannot bind the defaulted resource for this client', async () => {
      keycloak.reset(({ params }) => params.has('resource') ? jsonResponse(INVALID_TARGET, 400) : issueToken())

      const response = await clientCredentials()

      expect(response.status).toBe(200)
      expect(keycloak.calls.map(({ params }) => params.get('resource'))).toEqual([FHIR_RESOURCE, null])
    })

    it('passes invalid_target through for a resource the client asked for', async () => {
      keycloak.reset(() => jsonResponse(INVALID_TARGET, 400))

      const response = await clientCredentials({ resource: FHIR_RESOURCE })

      expect(response.status).toBe(400)
      expect(keycloak.calls).toHaveLength(1)
    })

    it('forwards a requested resource unchanged', async () => {
      await clientCredentials({ resource: DICOM_MCP })

      expect(forwarded().getAll('resource')).toEqual([DICOM_MCP])
    })

    it('answers invalid_target for a resource no client holds, without asking Keycloak', async () => {
      const response = await clientCredentials({ resource: UNKNOWN_RESOURCE })

      expect(response.status).toBe(400)
      expect((await readJson(response)).error).toBe('invalid_target')
      expect(keycloak.calls).toHaveLength(0)
    })

    it('refuses a client assertion that does not verify, without asking Keycloak', async () => {
      const res = await requestToken({
        grant_type: 'client_credentials',
        client_id: 'backend-svc',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'header.payload.signature',
        scope: 'system/*.read',
      })

      expect((await readJson(res)).error).toBe('invalid_client')
      expect(keycloak.calls).toHaveLength(0)
    })
  })

  describe('authorization_code', () => {
    it('forwards code and client_id with the redirect_uri', async () => {
      await requestToken({ grant_type: 'authorization_code', code: 'abc123', redirect_uri: 'http://app.local/callback', client_id: 'my-app' })

      expect(forwarded().get('grant_type')).toBe('authorization_code')
      expect(forwarded().get('code')).toBe('abc123')
      expect(forwarded().get('client_id')).toBe('my-app')
      expect(forwarded().get('redirect_uri')).toBe('http://app.local/callback')
    })

    it('forwards code_verifier (PKCE)', async () => {
      await requestToken({ grant_type: 'authorization_code', code: 'xyz', redirect_uri: 'http://app/cb', client_id: 'pkce-app', code_verifier: PKCE_VERIFIER })

      expect(forwarded().get('code_verifier')).toBe(PKCE_VERIFIER)
    })
  })

  it('refresh_token: forwards refresh_token, does NOT send redirect_uri', async () => {
    await requestToken({ grant_type: 'refresh_token', refresh_token: 'rt-abc', client_id: 'my-app' })

    expect(forwarded().get('grant_type')).toBe('refresh_token')
    expect(forwarded().get('refresh_token')).toBe('rt-abc')
    expect(forwarded().has('redirect_uri')).toBe(false)
  })

  it('device_code: forwards grant_type, device_code and code_verifier (PKCE) to KC', async () => {
    await requestToken({ grant_type: DEVICE_CODE, client_id: 'admin-ui', device_code: 'DEV-CODE-123', code_verifier: PKCE_VERIFIER })

    expect(forwarded().get('grant_type')).toBe(DEVICE_CODE)
    expect(forwarded().get('device_code')).toBe('DEV-CODE-123')
    expect(forwarded().get('code_verifier')).toBe(PKCE_VERIFIER)
    expect(forwarded().has('redirect_uri')).toBe(false)
  })

  describe('token-exchange', () => {
    it('forwards subject_token fields', async () => {
      await tokenExchange({ client_id: 'exchange-client', requested_token_type: ACCESS_TOKEN_TYPE, scope: 'patient/*.read' })

      expect(forwarded().get('subject_token')).toBe('access-token-xyz')
      expect(forwarded().get('subject_token_type')).toBe(ACCESS_TOKEN_TYPE)
      expect(forwarded().get('requested_token_type')).toBe(ACCESS_TOKEN_TYPE)
    })

    it('names the client holding the requested resource as audience, since Keycloak ignores resource', async () => {
      await tokenExchange({ resource: FHIR_RESOURCE })

      expect(forwarded().get('audience')).toBe('fhir-resource-server')
    })

    it('answers invalid_target for a resource no client holds, without asking Keycloak', async () => {
      const response = await tokenExchange({ resource: UNKNOWN_RESOURCE })

      expect(response.status).toBe(400)
      expect((await readJson(response)).error).toBe('invalid_target')
      expect(keycloak.calls).toHaveLength(0)
    })

    it('leaves an explicit audience alone', async () => {
      const loadsBefore = resourceClientLoads

      await tokenExchange({ audience: 'some-client', resource: FHIR_RESOURCE })

      expect(forwarded().get('audience')).toBe('some-client')
      expect(resourceClientLoads).toBe(loadsBefore)
    })
  })

  describe('response forwarding', () => {
    it('forwards KC error response status and body', async () => {
      const refusal = { error: 'unauthorized_client', error_description: 'Invalid client or Invalid client credentials' }
      keycloak.reset(() => jsonResponse(refusal, 401))

      const res = await clientCredentials({ client_id: 'bad-client', client_secret: 'wrong' })

      expect(res.status).toBe(401)
      expect(await readJson(res)).toEqual(refusal)
    })

    it('sets Cache-Control: no-store on all responses', async () => {
      const res = await clientCredentials()

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('pragma')).toBe('no-cache')
    })
  })
})
