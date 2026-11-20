import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { authRoutes } from '../src/routes/auth'
import { buildAuthorizationServerMetadata, buildOpenIdConfiguration } from '../src/lib/oidc-discovery'

const ORIGINAL_FETCH = globalThis.fetch

/**
 * The proxy stands in for CIMD clients itself, so discovery offers CIMD exactly when the proxy trusts a
 * domain, whatever Keycloak's own document claims.
 */
describe('Metadata CIMD tests', () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('GET /auth/.well-known/openid-configuration does not advertise CIMD', async () => {
    const mockOidc = {
      issuer: 'http://keycloak/realms/test',
      authorization_endpoint: 'http://keycloak/realms/test/protocol/openid-connect/auth',
      token_endpoint: 'http://keycloak/realms/test/protocol/openid-connect/token',
      token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic'],
      client_id_metadata_document_supported: true,
      scopes_supported: ['openid', 'fhirUser'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256']
    }

    const mockFetch = Object.assign(
      async () => new Response(JSON.stringify(mockOidc), { 
        status: 200, 
        headers: { 'content-type': 'application/json' } 
      }),
      { preconnect: () => {} }
    ) as typeof fetch
    globalThis.fetch = mockFetch

    const res = await authRoutes.handle(new Request('http://localhost/auth/.well-known/openid-configuration'))

    expect(res.status).toBe(200)
    const data = await res.json()
    
    expect(data.client_id_metadata_document_supported).toBeUndefined()
    // Verify endpoints are proxied
    expect(data.authorization_endpoint).toContain('/auth/authorize')
    expect(data.token_endpoint).toContain('/auth/token')
  })

  it('GET /auth/.well-known/oauth-authorization-server does not advertise CIMD', async () => {
    const mockOidc = {
      issuer: 'http://keycloak/realms/test',
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      scopes_supported: ['openid'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256']
    }

    const mockFetch = Object.assign(
      async () => new Response(JSON.stringify(mockOidc), { 
        status: 200, 
        headers: { 'content-type': 'application/json' } 
      }),
      { preconnect: () => {} }
    ) as typeof fetch
    globalThis.fetch = mockFetch

    const res = await authRoutes.handle(new Request('http://localhost/auth/.well-known/oauth-authorization-server'))

    expect(res.status).toBe(200)
    const data = await res.json()
    
    expect(data.client_id_metadata_document_supported).toBeUndefined()
    expect(data.authorization_endpoint).toContain('/auth/authorize')
    expect(data.token_endpoint_auth_methods_supported).toContain('none')
  })
})

describe('CIMD support follows the proxy, not Keycloak', () => {
  const KEYCLOAK_CLAIMS_CIMD = { issuer: 'http://keycloak/realms/test', client_id_metadata_document_supported: true }
  const BASE = 'https://proxy.example.com'

  it('advertises CIMD on both documents once the proxy trusts a domain', () => {
    const capabilities = { clientIdMetadataDocuments: true }
    expect(buildOpenIdConfiguration({ issuer: 'http://keycloak/realms/test' }, BASE, BASE, capabilities).client_id_metadata_document_supported).toBe(true)
    expect(buildAuthorizationServerMetadata({ issuer: 'http://keycloak/realms/test' }, BASE, BASE, capabilities).client_id_metadata_document_supported).toBe(true)
  })

  it("drops Keycloak's own claim while the proxy trusts none", () => {
    const capabilities = { clientIdMetadataDocuments: false }
    expect(buildOpenIdConfiguration(KEYCLOAK_CLAIMS_CIMD, BASE, BASE, capabilities).client_id_metadata_document_supported).toBeUndefined()
    expect(buildAuthorizationServerMetadata(KEYCLOAK_CLAIMS_CIMD, BASE, BASE, capabilities).client_id_metadata_document_supported).toBeUndefined()
  })
})
