// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { fakeFetch, jsonResponse } from './helpers/fake-fetch'
import { authRoutes } from '../src/routes/auth'
import { fhirServerStore } from '../src/lib/fhir-server-store'
import { config } from '../src/config'

const SERVER_ID = 'aud-test-server'
const REDIRECT_URI = 'http://localhost:3000/callback'

function redirectOf(res: Response): URL {
  expect(res.status).toBe(302)
  return new URL(res.headers.get('location') ?? '')
}

function expectRefused(res: Response, error?: string): URLSearchParams {
  const location = redirectOf(res)
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI)
  if (error) expect(location.searchParams.get('error')).toBe(error)
  else expect(location.searchParams.get('error')).not.toBeNull()
  return location.searchParams
}

function expectAccepted(res: Response): void {
  expect(redirectOf(res).searchParams.get('error')).toBeNull()
}

/** The proxy base of a server registered for these tests, under a version the proxy serves. */
async function configuredBase(): Promise<string> {
  await fhirServerStore.initializeServers()
  fhirServerStore.addServer(SERVER_ID, {
    name: 'Aud test',
    url: 'http://aud-test.upstream/fhir',
    identifier: SERVER_ID,
    metadata: { fhirVersion: '4.0.1', supported: true },
    lastUpdated: Date.now(),
  })
  return `${config.baseUrl}/${config.name}/${SERVER_ID}/${config.fhir.supportedVersions[0]}`
}

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_ENV = { ...process.env }

/**
 * Tests for the /auth/authorize endpoint's aud/resource parameter validation.
 *
 * Per SMART App Launch 2.2.0: `aud` must match a known FHIR endpoint URL.
 * Per MCP spec (RFC 8707, Section 2.5.1): `resource` must identify the MCP server.
 *
 * The authorize endpoint accepts both `aud` (SMART) and `resource` (RFC 8707) as
 * synonymous parameters, validating them against:
 * 1. The base of a configured FHIR server: {baseUrl}/{name}/{identifier}/{version}
 * 2. MCP endpoint: {baseUrl}{mcpPath}
 * The client's redirect_uri is registered, so a refusal goes back to it as an error
 * redirect (RFC 6749 §4.1.2.1) and an accepted request is redirected without one.
 */
describe.serial('Authorize endpoint aud/resource validation', () => {
  // Set env vars so Keycloak appears configured (needed for isKeycloakReachable)
  // and mock fetch to simulate Keycloak being reachable + FHIR metadata responses.
  beforeEach(() => {
    process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
    process.env.KEYCLOAK_REALM = 'test-realm'
    process.env.BASE_URL = 'http://localhost:8445'
    process.env.MCP_ENDPOINT_PATH = '/mcp'

    const mockFetch = fakeFetch((urlStr) => {
      if (urlStr.includes('/protocol/openid-connect/token')) {
        return jsonResponse({ access_token: 'admin-token', token_type: 'Bearer', expires_in: 300 })
      }
      if (urlStr.includes('/admin/realms/') && urlStr.includes('/clients')) {
        return jsonResponse([{ id: 'test-client-uuid', clientId: 'test-client', redirectUris: [REDIRECT_URI] }])
      }
      // Keycloak reachability check
      if (urlStr.includes('/realms/')) {
        return new Response(JSON.stringify({ realm: 'test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      // FHIR server metadata (CapabilityStatement)
      if (urlStr.includes('/fhir') || urlStr.includes(':8081')) {
        return new Response(JSON.stringify({
          resourceType: 'CapabilityStatement',
          fhirVersion: '4.0.1',
          status: 'active',
          software: { name: 'test-server' },
          implementation: { description: 'Test FHIR Server' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/fhir+json' }
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    globalThis.fetch = mockFetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key]
      else process.env[key] = ORIGINAL_ENV[key]
    }
  })

  // Helper to build authorize URL with aud or resource parameter
  function authorizeUrl(params: Record<string, string>): string {
    const search = new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      ...params,
    })
    return `http://localhost/auth/authorize?${search.toString()}`
  }

  // ────────────────────────────────────────────────────────────────────────────
  // VALID aud/resource values
  // ────────────────────────────────────────────────────────────────────────────

  it('accepts aud naming the base of a configured FHIR server', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({ aud: await configuredBase() })))
    expectAccepted(res)
  })

  it('accepts resource parameter (RFC 8707 synonym for aud)', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({ resource: await configuredBase() })))
    expectAccepted(res)
  })

  it('refuses an aud under the proxy name that names no configured server', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({
      aud: 'http://localhost:8445/proxy-smart-backend/some-server/R4'
    })))
    expectRefused(res, 'invalid_target')
  })

  it('refuses a path below a FHIR base, which is a resource rather than the server', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({ aud: `${await configuredBase()}/Patient` })))
    expectRefused(res, 'invalid_target')
  })

  it('a SMART request has to name its FHIR server', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({ scope: 'openid launch/patient patient/*.rs' })))
    expect(expectRefused(res).get('error_description')).toContain('aud')
  })

  it('accepts MCP endpoint URL as aud (MCP spec Section 2.5.1)', async () => {
    // MCP clients send resource=baseUrl+mcpPath per RFC 8707
    // config.mcp.path defaults to '/mcp'
    const res = await authRoutes.handle(new Request(authorizeUrl({
      aud: 'http://localhost:8445/mcp'
    })))
    expectAccepted(res)
  })

  it('accepts MCP endpoint URL as resource parameter', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({
      resource: 'http://localhost:8445/mcp'
    })))
    expectAccepted(res)
  })

  it('accepts MCP endpoint sub-path (e.g., /mcp/sse)', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({
      resource: 'http://localhost:8445/mcp/sse'
    })))
    expectAccepted(res)
  })

  it('passes through without aud when the request is not for a FHIR server', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({})))
    expectAccepted(res)
  })

  // ────────────────────────────────────────────────────────────────────────────
  // INVALID aud/resource values
  // ────────────────────────────────────────────────────────────────────────────

  it('rejects aud pointing to an unknown server', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({
      aud: 'https://evil.example.com/fhir'
    })))
    expect(expectRefused(res, 'invalid_target').get('error_description')).toContain('aud')
  })

  it('rejects resource pointing to an unrelated URL', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({
      resource: 'https://attacker.com/api'
    })))
    expectRefused(res, 'invalid_target')
  })

  it('rejects aud that is a prefix attack (similar but not matching)', async () => {
    // e.g., http://localhost:8445/proxy-smart-backend-evil/ should NOT match
    // because fhirBasePrefix is http://localhost:8445/proxy-smart-backend/
    const res = await authRoutes.handle(new Request(authorizeUrl({
      aud: 'http://localhost:8445/proxy-smart-backend-evil/server/R4'
    })))
    expectRefused(res, 'invalid_target')
  })

  it('rejects aud matching MCP path prefix but different base URL', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({
      aud: 'https://evil.com/mcp'
    })))
    expectRefused(res, 'invalid_target')
  })

  it('rejects aud that is a partial MCP endpoint match (e.g., /mcpevil)', async () => {
    // Must be exactly /mcp or /mcp/... not /mcpevil
    const res = await authRoutes.handle(new Request(authorizeUrl({
      aud: 'http://localhost:8445/mcpevil'
    })))
    expectRefused(res, 'invalid_target')
  })

  // ────────────────────────────────────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────────────────────────────────────

  it('prefers aud over resource when both are provided', async () => {
    // aud takes precedence (code: query.aud || query.resource)
    const res = await authRoutes.handle(new Request(authorizeUrl({
      aud: 'http://localhost:8445/mcp',
      resource: 'https://evil.example.com/fhir'
    })))
    // aud is valid (MCP endpoint), resource is ignored
    expectAccepted(res)
  })

  it('uses resource when aud is absent', async () => {
    const res = await authRoutes.handle(new Request(authorizeUrl({
      resource: 'https://evil.example.com/fhir'
    })))
    // resource is invalid — should be rejected
    expectRefused(res, 'invalid_target')
  })
})
