// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { TEST_BASE_URL, TEST_REALM, useTestEnv } from './helpers/test-env'

const TEST_KC_BASE_URL = 'http://keycloak:8080'
const TEST_KC_PUBLIC_URL = 'https://login.example.com'

mockLoggerModule()

import { smartConfigService } from '../src/lib/smart-config'
import { buildAuthorizationServerMetadata, sanitizeDiscoveryDocument } from '../src/lib/oidc-discovery'

const KC_REALM = `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`
const KEYCLOAK_OIDC = {
  issuer: KC_REALM,
  authorization_endpoint: `${KC_REALM}/protocol/openid-connect/auth`,
  token_endpoint: `${KC_REALM}/protocol/openid-connect/token`,
  revocation_endpoint: `${KC_REALM}/protocol/openid-connect/revoke`,
  jwks_uri: `${KC_REALM}/protocol/openid-connect/certs`,
  grant_types_supported: ['authorization_code'],
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic'],
}

const ORIGINAL_FETCH = globalThis.fetch

describe('SMART configuration advertises revocation, management and authorize-post', () => {
  useTestEnv({
    BASE_URL: TEST_BASE_URL,
    KEYCLOAK_BASE_URL: TEST_KC_BASE_URL,
    KEYCLOAK_PUBLIC_URL: TEST_KC_PUBLIC_URL,
    KEYCLOAK_REALM: TEST_REALM,
    CONSENT_APP_URL: undefined,
    SMART_CAPABILITIES: undefined,
  })

  beforeEach(() => {
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify(KEYCLOAK_OIDC), { status: 200, headers: { 'content-type': 'application/json' } }),
      { preconnect: () => {} },
    )
    smartConfigService.clearCache()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    smartConfigService.clearCache()
  })

  it('advertises the proxy revocation endpoint', async () => {
    const smart = await smartConfigService.getSmartConfiguration()

    expect(smart.revocation_endpoint).toBe(`${TEST_BASE_URL}/auth/revoke`)
  })

  it('advertises authorize-post among the capabilities', async () => {
    const smart = await smartConfigService.getSmartConfiguration()

    expect(smart.capabilities).toContain('authorize-post')
  })

  it("points management_endpoint at Keycloak's account console when no consent app is set", async () => {
    const smart = await smartConfigService.getSmartConfiguration()

    expect(smart.management_endpoint).toBe(`${TEST_KC_PUBLIC_URL}/realms/${TEST_REALM}/account/applications`)
  })

  it('points management_endpoint at the consent app when one is configured', async () => {
    process.env.CONSENT_APP_URL = 'https://consent.example.com/'

    const smart = await smartConfigService.getSmartConfiguration()

    expect(smart.management_endpoint).toBe('https://consent.example.com/')
  })
})

describe('OAuth discovery documents carry the proxy revocation endpoint', () => {
  it('rewrites the Keycloak revocation endpoint to the proxy instead of dropping it', () => {
    const doc = sanitizeDiscoveryDocument(KEYCLOAK_OIDC, TEST_BASE_URL)

    expect(doc.revocation_endpoint).toBe(`${TEST_BASE_URL}/auth/revoke`)
  })

  it('lists it in the RFC 8414 authorization server metadata', () => {
    const doc = buildAuthorizationServerMetadata(KEYCLOAK_OIDC, TEST_BASE_URL)

    expect(doc.revocation_endpoint).toBe(`${TEST_BASE_URL}/auth/revoke`)
  })
})
