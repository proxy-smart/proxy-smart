// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * MCP OAuth Metadata Routes — Integration Tests
 *
 * Tests the /.well-known/* endpoints for:
 *  - RFC 9728 Protected Resource Metadata correctness
 *  - RFC 8414 Authorization Server Metadata proxying
 *  - Path-scoped resource metadata variant
 *  - Correct URL construction (no double slashes, trailing slash handling)
 *  - Required fields per MCP spec
 *  - Keycloak fetch error handling (502 / 500)
 *  - "none" added to token_endpoint_auth_methods_supported
 *  - registration_endpoint points to proxy, not Keycloak
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

// ── Mock config ──────────────────────────────────────────────────────────────

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_KEYCLOAK_BASE = 'http://localhost:8080'
const TEST_REALM = 'proxy-smart'
const TEST_MCP_PATH = '/mcp'

// Set env vars so the real config module returns the values we need.
// IMPORTANT: Do NOT mock.module('../src/config') — that replaces the entire
// singleton with a partial object, permanently stripping ial, accessControl,
// etc. for all subsequent test files in the same bun process.
process.env.KEYCLOAK_BASE_URL = TEST_KEYCLOAK_BASE
process.env.KEYCLOAK_PUBLIC_URL = TEST_KEYCLOAK_BASE
process.env.KEYCLOAK_REALM = TEST_REALM

// NOTE: Do NOT mock.module('../src/lib/logger') — partial logger mocks leak
// to subsequent test files and break tests that use logger.consent, etc.

// The path-scoped metadata now answers only for MCP endpoints this deployment serves, so the
// route asks the server store. Safe to mock here (unlike config/logger, it holds no state other
// tests read): `hapi-fhir-server` has MCP on, `mcp-off-server` has it off.
mock.module('@/lib/fhir-server-store', () => ({
  ensureServersInitialized: async () => {},
  getServerInfoByName: async (name: string) =>
    name === 'hapi-fhir-server' ? { name, mcpEnabled: true }
    : name === 'mcp-off-server' ? { name, mcpEnabled: false }
    : undefined,
}))

// ── Import routes after mocks ────────────────────────────────────────────────

import { Elysia } from 'elysia'
const { mcpMetadataRoutes } = await import('../src/routes/auth/mcp-metadata')

function createApp() {
  return new Elysia().use(mcpMetadataRoutes)
}

// ── Keycloak OIDC mock response ──────────────────────────────────────────────

const MOCK_KEYCLOAK_OIDC = {
  issuer: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}`,
  authorization_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/auth`,
  token_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/token`,
  jwks_uri: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/certs`,
  registration_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/clients-registrations/openid-connect`,
  // Keycloak-direct endpoints the proxy must rewrite or drop, never leak.
  introspection_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/token/introspect`,
  userinfo_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/userinfo`,
  end_session_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/logout`,
  device_authorization_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/auth/device`,
  revocation_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/revoke`,
  pushed_authorization_request_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/ext/par/request`,
  backchannel_authentication_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/ext/ciba/auth`,
  // Nested mTLS-bound aliases the proxy does not front — must be stripped entirely.
  mtls_endpoint_aliases: {
    token_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/token`,
    revocation_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/revoke`,
    introspection_endpoint: `${TEST_KEYCLOAK_BASE}/realms/${TEST_REALM}/protocol/openid-connect/token/introspect`,
  },
  scopes_supported: ['openid', 'profile', 'email'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  code_challenge_methods_supported: ['S256'],
}

const ORIGINAL_FETCH = globalThis.fetch

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MCP Metadata — /.well-known/oauth-protected-resource', () => {
  it('returns 200 with correct RFC 9728 fields', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    // RFC 9728 required fields
    expect(body.resource).toBe(`${TEST_BASE_URL}${TEST_MCP_PATH}`)
    expect(body.authorization_servers).toBeInstanceOf(Array)
    expect(body.authorization_servers.length).toBeGreaterThan(0)
    expect(body.bearer_methods_supported).toContain('header')
  })

  it('authorization_servers points to proxy baseUrl, not Keycloak', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource'),
    )
    const body = await res.json()
    // Critical: MCP clients use this to discover the AS — must be our proxy
    expect(body.authorization_servers[0]).toBe(TEST_BASE_URL)
    expect(body.authorization_servers[0]).not.toContain('8080')
  })

  it('resource URL has no double slashes', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource'),
    )
    const body = await res.json()
    const url = body.resource as string
    // After the protocol, should have no double slashes
    const afterProtocol = url.replace('http://', '')
    expect(afterProtocol).not.toContain('//')
  })

  it('includes scopes_supported', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource'),
    )
    const body = await res.json()
    expect(body.scopes_supported).toBeInstanceOf(Array)
    expect(body.scopes_supported).toContain('openid')
  })

  it('does not require authentication', async () => {
    const app = createApp()
    // No Authorization header
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource'),
    )
    expect(res.status).toBe(200)
  })
})

describe('MCP Metadata — /.well-known/oauth-protected-resource/* (path-scoped)', () => {
  it('returns same structure as the root metadata', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource/mcp'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resource).toBe(`${TEST_BASE_URL}${TEST_MCP_PATH}`)
    expect(body.authorization_servers).toBeInstanceOf(Array)
  })

  it('describes the resource at the requested path, not the admin MCP', async () => {
    // §3.1 inserts the well-known segment between host and resource path, so this document
    // describes /fhir/hapi-fhir-server/mcp. Answering with the admin MCP made every
    // per-server FHIR endpoint unauthorizable: a client checking `resource` against what it
    // asked about sees a different URL and stops.
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource/fhir/hapi-fhir-server/mcp'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resource).toBe(`${TEST_BASE_URL}/fhir/hapi-fhir-server/mcp`)
    // The AS is the proxy for every resource it fronts — that part was already right.
    expect(body.authorization_servers[0]).toBe(TEST_BASE_URL)
  })

  it('never emits a double slash, whatever the client asked for', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource//mcp'),
    )
    const body = await res.json()
    expect((body.resource as string).replace(/^https?:\/\//, '')).not.toContain('//')
  })

  /*
   * The wildcard used to answer 200 for ANY path, so a client could discover an authorization
   * server for an endpoint that does not exist, or whose MCP is switched off, sign in against
   * it, and only then be refused. Metadata is a claim that the resource IS one.
   */
  it('does not describe a path that is not an MCP endpoint here', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource/this/is/not/real'),
    )
    expect(res.status).toBe(404)
  })

  it('does not describe a FHIR server whose MCP endpoint is disabled', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource/fhir/mcp-off-server/mcp'),
    )
    expect(res.status).toBe(404)
  })

  it('does not describe a FHIR server that does not exist', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource/fhir/nope/mcp'),
    )
    expect(res.status).toBe(404)
  })
})

describe('MCP Metadata — /.well-known/oauth-authorization-server', () => {
  beforeEach(() => {
    // Mock Keycloak OIDC fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('.well-known/openid-configuration')) {
        return new Response(JSON.stringify(MOCK_KEYCLOAK_OIDC), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return ORIGINAL_FETCH(input, init)
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('returns 200 with RFC 8414 fields', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.authorization_endpoint).toBeDefined()
    expect(body.token_endpoint).toBeDefined()
    expect(body.jwks_uri).toBeDefined()
    expect(body.registration_endpoint).toBeDefined()
    expect(body.scopes_supported).toBeInstanceOf(Array)
  })

  it('issuer is proxy baseUrl, not Keycloak', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    const body = await res.json()
    // Proxy acts as AS from MCP client perspective
    expect(body.issuer).toBe(TEST_BASE_URL)
    expect(body.issuer).not.toContain('8080')
  })

  it('registration_endpoint points to proxy /auth/register, not Keycloak', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    const body = await res.json()
    expect(body.registration_endpoint).toBe(`${TEST_BASE_URL}/auth/register`)
    // Must NOT point to Keycloak's native DCR endpoint
    expect(body.registration_endpoint).not.toContain('clients-registrations')
  })

  it('adds "none" to token_endpoint_auth_methods_supported for public MCP clients', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    const body = await res.json()
    expect(body.token_endpoint_auth_methods_supported).toContain('none')
    // Should also preserve existing methods from Keycloak
    expect(body.token_endpoint_auth_methods_supported).toContain('client_secret_basic')
  })

  it('does not duplicate "none" if Keycloak already includes it', async () => {
    const oidcWithNone = {
      ...MOCK_KEYCLOAK_OIDC,
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('.well-known/openid-configuration')) {
        return new Response(JSON.stringify(oidcWithNone), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return ORIGINAL_FETCH(input)
    }) as typeof fetch

    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    const body = await res.json()
    const noneCount = body.token_endpoint_auth_methods_supported.filter(
      (m: string) => m === 'none',
    ).length
    expect(noneCount).toBe(1)
  })

  it('rewrites authorization/token endpoints to proxy URLs', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    const body = await res.json()
    // MCP clients must go through our proxy (SMART context enrichment, backend services, aud enforcement)
    expect(body.authorization_endpoint).toBe(`${TEST_BASE_URL}/auth/authorize`)
    expect(body.token_endpoint).toBe(`${TEST_BASE_URL}/auth/token`)
    expect(body.jwks_uri).toBe(`${TEST_BASE_URL}/.well-known/jwks.json`)
  })

  it('returns 502 when Keycloak is unreachable', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('.well-known/openid-configuration')) {
        return new Response('Service Unavailable', { status: 503 })
      }
      return ORIGINAL_FETCH(input)
    }) as typeof fetch

    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('bad_gateway')
  })

  it('returns 500 when Keycloak fetch throws network error', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('.well-known/openid-configuration')) {
        throw new Error('ECONNREFUSED')
      }
      return ORIGINAL_FETCH(input)
    }) as typeof fetch

    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('server_error')
  })

  it('does not require authentication', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    // No auth header — should still work (public endpoint)
    expect(res.status).toBe(200)
  })

  it('includes code_challenge_methods_supported for PKCE', async () => {
    const app = createApp()
    const res = await app.handle(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    )
    const body = await res.json()
    expect(body.code_challenge_methods_supported).toBeInstanceOf(Array)
    expect(body.code_challenge_methods_supported).toContain('S256')
  })
})

describe('Discovery docs do not leak Keycloak-direct endpoints', () => {
  // Every proxy discovery response must rewrite proxy-fronted endpoints, strip
  // mtls_endpoint_aliases, and advertise NO Keycloak-direct
  // /protocol/openid-connect/ URL — otherwise an mTLS client (or anything reading
  // the doc) could bypass the proxy's auth layer.
  beforeEach(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('.well-known/openid-configuration')) {
        return new Response(JSON.stringify(MOCK_KEYCLOAK_OIDC), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return ORIGINAL_FETCH(input, init)
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  // All proxy discovery variants served by this route module.
  const DISCOVERY_PATHS = [
    '/.well-known/openid-configuration',
    '/.well-known/openid-configuration/auth',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/auth',
  ] as const

  // RFC 8414 §3.3: a metadata document's `issuer` MUST match the URL it was
  // retrieved from. Every one of these is served FROM the proxy origin, so every
  // one of them must name the proxy — including the OIDC-mirror variants, which
  // used to pass Keycloak's realm issuer straight through while rewriting only the
  // endpoints. That published Keycloak's identity with the proxy's endpoints, and
  // it is the issuer a client later compares the RFC 9207 `iss` against.
  for (const path of DISCOVERY_PATHS) {
    it(`${path} advertises the proxy as issuer, never Keycloak`, async () => {
      const app = createApp()
      const res = await app.handle(new Request(`http://localhost${path}`))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.issuer).toBe(TEST_BASE_URL)
      expect(body.issuer).not.toContain(TEST_REALM)
    })

    it(`${path} contains no /protocol/openid-connect/ substring`, async () => {
      const app = createApp()
      const res = await app.handle(new Request(`http://localhost${path}`))
      expect(res.status).toBe(200)
      const raw = JSON.stringify(await res.json())
      expect(raw).not.toContain('/protocol/openid-connect/')
    })

    it(`${path} has no mtls_endpoint_aliases key`, async () => {
      const app = createApp()
      const res = await app.handle(new Request(`http://localhost${path}`))
      const body = await res.json()
      expect(body).not.toHaveProperty('mtls_endpoint_aliases')
    })

    it(`${path} advertises the proxy revocation endpoint and no unsupported ones (PAR/CIBA)`, async () => {
      const app = createApp()
      const res = await app.handle(new Request(`http://localhost${path}`))
      const body = await res.json()
      expect(body.revocation_endpoint).toBe(`${TEST_BASE_URL}/auth/revoke`)
      expect(body).not.toHaveProperty('pushed_authorization_request_endpoint')
      expect(body).not.toHaveProperty('backchannel_authentication_endpoint')
    })
  }

  // The OIDC-mirror variants spread Keycloak's doc, so they are the ones that
  // must rewrite token/device endpoints (and end_session) to the proxy origin.
  for (const path of ['/.well-known/openid-configuration', '/.well-known/openid-configuration/auth'] as const) {
    it(`${path} still advertises proxy token + device endpoints`, async () => {
      const app = createApp()
      const res = await app.handle(new Request(`http://localhost${path}`))
      const body = await res.json()
      expect(body.token_endpoint).toBe(`${TEST_BASE_URL}/auth/token`)
      expect(body.device_authorization_endpoint).toBe(`${TEST_BASE_URL}/auth/device`)
      // end_session is rewritten to the proxy /auth/logout route, not dropped.
      expect(body.end_session_endpoint).toBe(`${TEST_BASE_URL}/auth/logout`)
    })
  }
})
