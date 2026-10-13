// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * A per-server FHIR MCP endpoint must be namable as an RFC 8707 `resource`.
 *
 * Enabling one made it serve requests, publish protected-resource metadata and return a proper
 * challenge — but `validateAudience` knew only the FHIR base, the admin MCP and the per-server
 * FHIR DATA endpoints. So authorize answered
 * `aud parameter does not match a known endpoint on this server`, and no client could ever
 * obtain a token for an endpoint the deployment was actively serving.
 *
 * A server with its MCP switched off is deliberately still refused: the endpoint 403s, its
 * metadata 404s, and a token naming it would be a token for nothing.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_ENV = { ...process.env }

const BASE_URL = 'http://localhost:8445'

// Spread the real module: a whole-module replacement drops the exports its OTHER importers
// need, and the store has a wide surface. Only the two readers here are overridden.
const store = await import('@/lib/fhir-server-store')
mock.module('@/lib/fhir-server-store', () => ({
  ...store,
  ensureServersInitialized: async () => {},
  getAllServers: async () => [
    { identifier: 'mcp-on-server', name: 'On', url: 'http://localhost:8081/fhir', mcpEnabled: true },
    { identifier: 'mcp-off-server', name: 'Off', url: 'http://localhost:8082/fhir', mcpEnabled: false },
  ],
  getServerInfoByName: async (id: string) =>
    id === 'mcp-on-server' ? { identifier: id, mcpEnabled: true }
    : id === 'mcp-off-server' ? { identifier: id, mcpEnabled: false }
    : undefined,
}))

const { authRoutes } = await import('../src/routes/auth')

describe('authorize accepts a served per-server FHIR MCP endpoint as the resource', () => {
  beforeEach(() => {
    process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
    process.env.KEYCLOAK_REALM = 'test-realm'
    process.env.BASE_URL = BASE_URL
    process.env.MCP_ENDPOINT_PATH = '/mcp'

    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify({ realm: 'test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      { preconnect: () => {} },
    ) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    process.env = { ...ORIGINAL_ENV }
  })

  function authorize(resource: string): Promise<Response> {
    const search = new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: 'http://localhost:3000/callback',
      scope: 'openid',
      resource,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })
    return authRoutes.handle(new Request(`http://localhost/auth/authorize?${search.toString()}`))
  }

  it('accepts the MCP endpoint of a server that has it enabled', async () => {
    const res = await authorize(`${BASE_URL}/fhir/mcp-on-server/mcp`)

    expect(res.status).not.toBe(400)
  })

  it('refuses the MCP endpoint of a server that has it disabled', async () => {
    const res = await authorize(`${BASE_URL}/fhir/mcp-off-server/mcp`)

    expect(res.status).toBe(400)
  })

  it('refuses the MCP endpoint of a server that does not exist', async () => {
    const res = await authorize(`${BASE_URL}/fhir/no-such-server/mcp`)

    expect(res.status).toBe(400)
  })

  it('refuses a lookalike that is not the MCP path', async () => {
    const res = await authorize(`${BASE_URL}/fhir/mcp-on-server/mcpevil`)

    expect(res.status).toBe(400)
  })
})
