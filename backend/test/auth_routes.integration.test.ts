import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import { authRoutes } from '../src/routes/auth'

const ORIGINAL_FETCH = globalThis.fetch

describe('Auth route integration tests', () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('GET /auth/config returns a keycloak object with isConfigured boolean when Keycloak is reachable', async () => {
    // Create a proper fetch mock with all required properties
    const mockFetch = Object.assign(
      async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }),
      { preconnect: () => {} }
    ) as typeof fetch
    globalThis.fetch = mockFetch

    const res = await authRoutes.handle(new Request('http://localhost/auth/config'))

    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') || ''
    expect(ct.toLowerCase()).toContain('application/json')

    const data = await res.json()
    expect(data).toHaveProperty('keycloak')
    expect(data.keycloak).toHaveProperty('isConfigured')
    expect(typeof data.keycloak.isConfigured).toBe('boolean')

    if ('clientId' in data.keycloak && data.keycloak.clientId !== undefined && data.keycloak.clientId !== null) {
      expect(typeof data.keycloak.clientId).toBe('string')
    }
  })

  it('GET /auth/config responds gracefully when Keycloak connectivity check throws', async () => {
    // Create a proper fetch mock that throws but has all required properties
    const mockFetch = Object.assign(
      async () => { throw new Error('network down') },
      { preconnect: () => {} }
    ) as typeof fetch
    globalThis.fetch = mockFetch

    const res = await authRoutes.handle(new Request('http://localhost/auth/config'))

    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') || ''
    expect(ct.toLowerCase()).toContain('application/json')

    const data = await res.json()
    expect(data).toHaveProperty('keycloak')
    expect(data.keycloak).toHaveProperty('isConfigured')
    expect(typeof data.keycloak.isConfigured).toBe('boolean')
  })
})

describe('Token endpoint form body parsing', () => {
  beforeEach(() => {
    // Mock fetch to capture what the token endpoint forwards to Keycloak
    const mockFetch = Object.assign(
      async () => new Response(JSON.stringify({ error: 'test_mock', error_description: 'mock keycloak' }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      }),
      { preconnect: () => {} }
    ) as typeof fetch
    globalThis.fetch = mockFetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('correctly parses client_assertion_type when client_assertion contains a real RS384 JWT', async () => {
    // Generate a real RS384 JWT — the signature bytes previously broke Elysia's form parser
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const realJwt = jwt.sign(
      { iss: 'test-client', sub: 'test-client', aud: 'http://localhost:8445/auth/token', jti: 'test-jti' },
      privateKey,
      { algorithm: 'RS384', expiresIn: 300, header: { alg: 'RS384', kid: 'test-kid', typ: 'JWT' } }
    )

    // Build form body with client_assertion_type AFTER the long JWT value
    const formBody = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'test-backend-service',
      client_assertion: realJwt,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    })

    const res = await authRoutes.handle(new Request('http://localhost/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    }))

    const data = await res.json()
    // The key assertion: we should NOT get "client_assertion_type is missing"
    // If the form parser bug recurs, client_assertion_type won't be parsed
    // and the backend-services handler will fail with a different error
    expect(data.error).not.toBe('invalid_request')
    expect(data.error_description).not.toContain('client_assertion_type')
  })
})

describe('Auth discovery doc does not leak Keycloak-direct endpoints', () => {
  // Keycloak OIDC doc loaded with the Keycloak-direct endpoints + mTLS aliases the
  // proxy must rewrite or strip. Realm is whatever the test-config resolves to;
  // the protocol/openid-connect/ path marker is what matters for the leak check.
  const KC_OIDC_WITH_LEAKS = {
    issuer: 'http://keycloak/realms/proxy-smart',
    authorization_endpoint: 'http://keycloak/realms/proxy-smart/protocol/openid-connect/auth',
    token_endpoint: 'http://keycloak/realms/proxy-smart/protocol/openid-connect/token',
    jwks_uri: 'http://keycloak/realms/proxy-smart/protocol/openid-connect/certs',
    end_session_endpoint: 'http://keycloak/realms/proxy-smart/protocol/openid-connect/logout',
    device_authorization_endpoint: 'http://keycloak/realms/proxy-smart/protocol/openid-connect/auth/device',
    revocation_endpoint: 'http://keycloak/realms/proxy-smart/protocol/openid-connect/revoke',
    pushed_authorization_request_endpoint: 'http://keycloak/realms/proxy-smart/protocol/openid-connect/ext/par/request',
    backchannel_authentication_endpoint: 'http://keycloak/realms/proxy-smart/protocol/openid-connect/ext/ciba/auth',
    mtls_endpoint_aliases: {
      token_endpoint: 'http://keycloak/realms/proxy-smart/protocol/openid-connect/token',
    },
    scopes_supported: ['openid', 'profile'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
  }

  beforeEach(() => {
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('.well-known/openid-configuration')) {
          return new Response(JSON.stringify(KC_OIDC_WITH_LEAKS), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return ORIGINAL_FETCH(input)
      },
      { preconnect: () => {} },
    ) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('GET /auth/.well-known/openid-configuration strips all Keycloak-direct URLs and mtls aliases', async () => {
    const res = await authRoutes.handle(
      new Request('http://localhost/auth/.well-known/openid-configuration'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(JSON.stringify(body)).not.toContain('/protocol/openid-connect/')
    expect(body).not.toHaveProperty('mtls_endpoint_aliases')
    expect(body).not.toHaveProperty('pushed_authorization_request_endpoint')
    expect(body).not.toHaveProperty('backchannel_authentication_endpoint')

    // Proxy-fronted endpoints are rewritten to the proxy origin and still present.
    expect(body.token_endpoint).toContain('/auth/token')
    expect(body.device_authorization_endpoint).toContain('/auth/device')
    expect(body.end_session_endpoint).toContain('/auth/logout')
    expect(body.revocation_endpoint).toContain('/auth/revoke')
  })
})
