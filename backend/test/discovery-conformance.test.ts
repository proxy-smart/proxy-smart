// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_KC_BASE_URL = 'http://keycloak:8080'
const TEST_REALM = 'smart-health'

const CONFIG_ENV_VARS = {
  BASE_URL: TEST_BASE_URL,
  KEYCLOAK_BASE_URL: TEST_KC_BASE_URL,
  KEYCLOAK_PUBLIC_URL: TEST_KC_BASE_URL,
  KEYCLOAK_REALM: TEST_REALM,
  SMART_CAPABILITIES: undefined,
  SMART_SCOPES_SUPPORTED: undefined,
} as const

mockLoggerModule()

import { smartConfigService } from '../src/lib/smart-config'
import { buildAuthorizationServerMetadata, buildOpenIdConfiguration } from '../src/lib/oidc-discovery'
import { fhirRoutes } from '../src/routes/fhir'
import { fhirServerStore } from '../src/lib/fhir-server-store'
import { config } from '../src/config'

const KC_REALM = `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`

/** What Keycloak 26 advertises with every feature switched on. */
const KEYCLOAK_OIDC = {
  issuer: KC_REALM,
  authorization_endpoint: `${KC_REALM}/protocol/openid-connect/auth`,
  token_endpoint: `${KC_REALM}/protocol/openid-connect/token`,
  end_session_endpoint: `${KC_REALM}/protocol/openid-connect/logout`,
  jwks_uri: `${KC_REALM}/protocol/openid-connect/certs`,
  grant_types_supported: [
    'authorization_code', 'implicit', 'refresh_token', 'password', 'client_credentials',
    'urn:openid:params:grant-type:ciba', 'urn:ietf:params:oauth:grant-type:device_code',
    'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:uma-ticket',
  ],
  response_types_supported: ['code', 'none', 'id_token', 'token', 'id_token token', 'code id_token', 'code token', 'code id_token token'],
  code_challenge_methods_supported: ['plain', 'S256'],
  token_endpoint_auth_methods_supported: [
    'private_key_jwt', 'client_secret_basic', 'client_secret_post', 'tls_client_auth', 'client_secret_jwt',
  ],
  token_endpoint_auth_signing_alg_values_supported: ['PS384', 'RS384', 'EdDSA', 'ES384', 'HS256', 'HS512', 'ES256', 'RS256', 'HS384', 'ES512', 'PS256', 'PS512', 'RS512'],
  introspection_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic', 'client_secret_post', 'tls_client_auth', 'client_secret_jwt'],
  revocation_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic', 'client_secret_post', 'tls_client_auth', 'client_secret_jwt'],
  scopes_supported: [
    'openid', 'profile', 'email', 'fhirUser', 'launch', 'launch/patient', 'offline_access',
    'patient/*.rs', 'patient/Observation.rs', 'user/*.rs',
    'web-origins', 'roles', 'acr', 'microprofile-jwt', 'resource-indicators', 'basic',
  ],
}

const KEYCLOAK_INTERNAL = ['web-origins', 'roles', 'acr', 'microprofile-jwt', 'resource-indicators', 'basic']
const UNWORKABLE_GRANTS = ['implicit', 'password', 'urn:openid:params:grant-type:ciba', 'urn:ietf:params:oauth:grant-type:uma-ticket']
const UNWORKABLE_AUTH = ['tls_client_auth', 'client_secret_jwt']

const ORIGINAL_FETCH = globalThis.fetch
let keycloakUp = true

const configured = (overrides: Record<string, string> = {}) => {
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value
  smartConfigService.clearCache()
}

describe('discovery advertises only what works through the proxy', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      savedEnv[key] = process.env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fhirServerStore.initializeServers()
    for (const server of fhirServerStore.getAllServers()) fhirServerStore.removeServer(server.identifier)
    fhirServerStore.addServer('alpha', {
      name: 'alpha', url: 'http://upstream-alpha.test/fhir', identifier: 'alpha',
      metadata: { fhirVersion: 'R4', supported: true }, lastUpdated: Date.now(),
    })
    keycloakUp = true
    globalThis.fetch = Object.assign(
      async () => keycloakUp
        ? new Response(JSON.stringify(KEYCLOAK_OIDC), { status: 200, headers: { 'content-type': 'application/json' } })
        : Promise.reject(new Error('connect ECONNREFUSED')),
      { preconnect: () => {} },
    )
    smartConfigService.clearCache()
  })

  afterEach(() => {
    for (const key of Object.keys(CONFIG_ENV_VARS)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    globalThis.fetch = ORIGINAL_FETCH
    smartConfigService.clearCache()
  })

  const documents = async () => [
    await smartConfigService.getSmartConfiguration(),
    buildOpenIdConfiguration(KEYCLOAK_OIDC, TEST_BASE_URL),
    buildAuthorizationServerMetadata(KEYCLOAK_OIDC, TEST_BASE_URL),
  ]

  it('leaves out grant types the proxy cannot carry', async () => {
    for (const document of await documents()) {
      const grants = document.grant_types_supported
      expect(grants).toEqual(expect.arrayContaining([
        'authorization_code', 'refresh_token', 'client_credentials',
        'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:device_code',
      ]))
      for (const grant of UNWORKABLE_GRANTS) expect(grants).not.toContain(grant)
    }
  })

  it('advertises the code flow only', async () => {
    for (const document of await documents()) expect(document.response_types_supported).toEqual(['code'])
  })

  it('advertises only the client authentication the proxy can relay', async () => {
    for (const document of await documents()) {
      const methods = document.token_endpoint_auth_methods_supported
      expect(methods).toEqual(expect.arrayContaining(['private_key_jwt', 'client_secret_basic', 'client_secret_post', 'none']))
      for (const method of UNWORKABLE_AUTH) expect(methods).not.toContain(method)
    }
    const openid = buildOpenIdConfiguration(KEYCLOAK_OIDC, TEST_BASE_URL)
    for (const key of ['introspection_endpoint_auth_methods_supported', 'revocation_endpoint_auth_methods_supported']) {
      for (const method of UNWORKABLE_AUTH) expect(openid[key]).not.toContain(method)
    }
  })

  it('advertises the asymmetric algorithms the proxy verifies client assertions with', async () => {
    const [smart, openid] = await documents()
    for (const algs of [smart.token_endpoint_auth_signing_alg_values_supported, openid.token_endpoint_auth_signing_alg_values_supported]) {
      expect(algs).toEqual(expect.arrayContaining(['RS384', 'ES384']))
      for (const alg of ['HS256', 'HS384', 'HS512', 'EdDSA']) expect(algs).not.toContain(alg)
    }
  })

  it('advertises scopes that exist in Keycloak, without its internal ones', async () => {
    for (const document of await documents()) {
      const scopes = document.scopes_supported
      for (const internal of KEYCLOAK_INTERNAL) expect(scopes).not.toContain(internal)
      expect(scopes).toEqual(expect.arrayContaining(['openid', 'fhirUser', 'launch/patient', 'patient/*.rs']))
    }
    const { scopes_supported } = await smartConfigService.getSmartConfiguration()
    expect(scopes_supported).not.toContain('patient/*.cruds')
    expect(scopes_supported).not.toContain('system/*.rs')
  })

  describe('SMART configuration', () => {
    it('omits issuer when sso-openid-connect is not advertised', async () => {
      configured({ SMART_CAPABILITIES: 'launch-standalone,client-public,permission-v2' })
      const smart = await smartConfigService.getSmartConfiguration()

      expect('issuer' in smart).toBe(false)
    })

    it('keeps issuer when sso-openid-connect is advertised', async () => {
      const smart = await smartConfigService.getSmartConfiguration()
      expect(smart.issuer).toBe(KC_REALM)
    })

    it('emits associated_endpoints only alongside smart-app-state', async () => {
      configured({ SMART_CAPABILITIES: 'launch-standalone,sso-openid-connect' })
      expect('associated_endpoints' in await smartConfigService.getSmartConfiguration()).toBe(false)

      configured({ SMART_CAPABILITIES: 'launch-standalone,sso-openid-connect,smart-app-state' })
      expect((await smartConfigService.getSmartConfiguration()).associated_endpoints).toHaveLength(1)
    })
  })

  describe('the .well-known/smart-configuration route', () => {
    const get = (server: string, version: string) =>
      fhirRoutes.handle(new Request(`${TEST_BASE_URL}/${config.name}/${server}/${version}/.well-known/smart-configuration`))

    it('answers for a registered server', async () => {
      const res = await get('alpha', 'R4')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
    })

    it('answers 404 in JSON for a server that does not exist', async () => {
      const res = await get('nowhere', 'R4')
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect((await res.json()).error).toBeTruthy()
    })

    it('answers 404 in JSON for a FHIR version the proxy does not serve', async () => {
      const res = await get('alpha', 'R9')
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
    })

    it('answers in JSON when Keycloak cannot be reached', async () => {
      keycloakUp = false
      const res = await get('alpha', 'R4')
      expect(res.status).toBe(503)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect((await res.json()).error).toBe('temporarily_unavailable')
    })
  })
})
