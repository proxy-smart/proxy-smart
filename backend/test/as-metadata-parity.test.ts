// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { authRoutes } from '../src/routes/auth'
import { mcpMetadataRoutes } from '../src/routes/auth/mcp-metadata'

const ORIGINAL_FETCH = globalThis.fetch

const MOCK_OIDC = {
  issuer: 'http://keycloak/realms/test',
  authorization_endpoint: 'http://keycloak/realms/test/protocol/openid-connect/auth',
  token_endpoint: 'http://keycloak/realms/test/protocol/openid-connect/token',
  token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic'],
  scopes_supported: ['openid', 'fhirUser'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
}

/**
 * Every path below serves Authorization Server Metadata for the SAME authorization
 * server, so every path must advertise the same capabilities. They were hand-written
 * three times and had drifted: an MCP client saw a different document depending on
 * which discovery path it resolved first.
 */
const AS_METADATA_PATHS = [
  { path: '/auth/.well-known/oauth-authorization-server', routes: authRoutes },
  { path: '/.well-known/oauth-authorization-server', routes: mcpMetadataRoutes },
  { path: '/.well-known/oauth-authorization-server/auth', routes: mcpMetadataRoutes },
] as const

const CAPABILITY_KEYS = [
  'authorization_response_iss_parameter_supported',
  'client_registration_types_supported',
  'client_id_metadata_document_supported',
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'device_authorization_endpoint',
  'jwks_uri',
  'registration_endpoint',
  'token_endpoint_auth_methods_supported',
] as const

async function fetchMetadata(entry: typeof AS_METADATA_PATHS[number]): Promise<Record<string, unknown>> {
  const res = await entry.routes.handle(new Request(`http://localhost${entry.path}`))
  expect(res.status).toBe(200)
  return res.json() as Promise<Record<string, unknown>>
}

describe('Authorization Server Metadata parity across discovery paths', () => {
  beforeEach(() => {
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify(MOCK_OIDC), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      { preconnect: () => {} },
    ) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('advertises identical capabilities on every discovery path', async () => {
    const documents = await Promise.all(AS_METADATA_PATHS.map(fetchMetadata))
    const [reference, ...rest] = documents

    for (const key of CAPABILITY_KEYS) {
      expect(reference[key]).toBeDefined()
      for (const document of rest) {
        expect(document[key]).toEqual(reference[key])
      }
    }
  })

  for (const entry of AS_METADATA_PATHS) {
    it(`${entry.path} advertises RFC 9207 iss support`, async () => {
      const document = await fetchMetadata(entry)
      expect(document.authorization_response_iss_parameter_supported).toBe(true)
    })

    it(`${entry.path} advertises CIMD and DCR registration`, async () => {
      const document = await fetchMetadata(entry)
      expect(document.client_id_metadata_document_supported).toBe(true)
      expect(document.client_registration_types_supported).toEqual([
        'client_id_metadata_document',
        'dynamic_client_registration',
      ])
    })

    it(`${entry.path} advertises "none" auth for public MCP clients`, async () => {
      const document = await fetchMetadata(entry)
      expect(document.token_endpoint_auth_methods_supported).toContain('none')
    })
  }
})
