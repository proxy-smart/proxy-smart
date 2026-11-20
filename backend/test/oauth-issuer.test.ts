// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { useTestEnv } from './helpers/test-env'

mockLoggerModule()

import { Elysia } from 'elysia'
import { config } from '../src/config'
import { smartProxyConfig } from '../src/routes/auth/smart-proxy-setup'
const { mcpMetadataRoutes } = await import('../src/routes/auth/mcp-metadata')
const { authRoutes } = await import('../src/routes/auth')

const REALM = 'proxy-smart'
const SAME_HOST_KEYCLOAK = `${config.baseUrl}/auth`
const REALM_ISSUER = `${SAME_HOST_KEYCLOAK}/realms/${REALM}`

const KEYCLOAK_OIDC = {
  issuer: REALM_ISSUER,
  authorization_endpoint: `${REALM_ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${REALM_ISSUER}/protocol/openid-connect/token`,
  jwks_uri: `${REALM_ISSUER}/protocol/openid-connect/certs`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic'],
}

const app = new Elysia().use(mcpMetadataRoutes).use(authRoutes)
const get = async (path: string) => app.handle(new Request(`${config.baseUrl}${path}`))
const ORIGINAL_FETCH = globalThis.fetch

describe('the advertised issuer is the one tokens carry', () => {
  useTestEnv({ KEYCLOAK_BASE_URL: 'http://keycloak:8080/auth', KEYCLOAK_PUBLIC_URL: SAME_HOST_KEYCLOAK, KEYCLOAK_REALM: REALM })

  beforeEach(() => {
    globalThis.fetch = (async () => Response.json(KEYCLOAK_OIDC)) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it("is Keycloak's realm issuer once Keycloak is served on the proxy's origin, and the origin otherwise", () => {
    expect(config.oauthIssuer).toBe(REALM_ISSUER)
    process.env.KEYCLOAK_PUBLIC_URL = 'https://auth.example.com'
    expect(config.oauthIssuer).toBe(config.baseUrl)
  })

  it('serves RFC 8414 metadata at the issuer path, naming that issuer and the proxy endpoints', async () => {
    const res = await get(`/.well-known/oauth-authorization-server/auth/realms/${REALM}`)
    expect(res.status).toBe(200)
    const doc = await res.json()
    expect(doc.issuer).toBe(REALM_ISSUER)
    expect(doc.authorization_endpoint).toBe(`${config.baseUrl}/auth/authorize`)
    expect(doc.token_endpoint).toBe(`${config.baseUrl}/auth/token`)
    expect(doc.authorization_response_iss_parameter_supported).toBe(true)
  })

  it('serves OpenID discovery at both places a client derives from that issuer', async () => {
    for (const path of [`/auth/realms/${REALM}/.well-known/openid-configuration`, `/.well-known/openid-configuration/auth/realms/${REALM}`]) {
      const res = await get(path)
      expect(res.status).toBe(200)
      expect((await res.json()).issuer).toBe(REALM_ISSUER)
    }
  })

  it('answers 404 for a path that names no issuer of this deployment', async () => {
    expect((await get('/.well-known/oauth-authorization-server/auth/realms/other')).status).toBe(404)
    expect((await get('/auth/realms/other/.well-known/openid-configuration')).status).toBe(404)
  })

  it('names that issuer as the MCP authorization server and on every authorization response', async () => {
    const prm = await (await get('/.well-known/oauth-protected-resource')).json()
    expect(prm.authorization_servers).toEqual([REALM_ISSUER])
    expect(smartProxyConfig.issuer).toBe(REALM_ISSUER)
  })
})
