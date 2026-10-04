import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { authRoutes } from '../src/routes/auth'
import { rememberCimd } from './helpers/cimd-status'

const ORIGINAL_FETCH = globalThis.fetch

describe('Metadata CIMD tests', () => {
  beforeEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH
    await rememberCimd(true)
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('GET /auth/.well-known/openid-configuration includes client_id_metadata_document_supported', async () => {
    const mockOidc = {
      issuer: 'http://keycloak/realms/test',
      authorization_endpoint: 'http://keycloak/realms/test/protocol/openid-connect/auth',
      token_endpoint: 'http://keycloak/realms/test/protocol/openid-connect/token',
      token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic'],
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
    
    expect(data.client_id_metadata_document_supported).toBe(true)
    // Verify endpoints are proxied
    expect(data.authorization_endpoint).toContain('/auth/authorize')
    expect(data.token_endpoint).toContain('/auth/token')
  })

  it('GET /auth/.well-known/oauth-authorization-server includes client_id_metadata_document_supported', async () => {
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
    
    expect(data.client_id_metadata_document_supported).toBe(true)
    expect(data.authorization_endpoint).toContain('/auth/authorize')
    expect(data.token_endpoint_auth_methods_supported).toContain('none')
  })
})
