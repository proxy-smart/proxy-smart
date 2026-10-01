// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * MCP Streamable HTTP Endpoint — Integration Tests (TDD)
 *
 * Tests the /mcp endpoint against the MCP 2025-03-26 specification.
 * Written test-first to expose real bugs, then code is fixed.
 *
 * Key spec requirements covered:
 *  - Auth: 401 + RFC 9728 WWW-Authenticate header on every HTTP method
 *  - Session: initialize → session ID → tools/list + tools/call
 *  - Session: unknown session → 404 (spec §Session Management rule 3)
 *  - Session: DELETE tears down session, subsequent requests get 404
 *  - Disabled: file-config alone can disable endpoint (returns 404)
 *  - Protocol: server info, protocol version, capabilities shape
 *  - Tools: tools/list works after initialized notification
 *  - Tools: search_documentation is registered and callable
 *  - Path params: correct extraction and body/param separation
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ── Mock auth module before importing route code ─────────────────────────────

const mockValidateToken = mock(async (_token: string) => ({
  sub: 'test-user',
  azp: 'mcp-test-client',
  iss: 'http://localhost:8080/realms/proxy-smart',
  realm_access: { roles: ['admin'] },
  resource_access: {},
}))

mock.module('../src/lib/auth', () => ({
  validateToken: mockValidateToken,
}))

mock.module('../src/lib/keycloak-plugin', () => ({
  createAdminClient: () => ({}),
}))

// Deterministic origin policy for the DNS-rebinding guard.
mock.module('../src/lib/cors-origins', () => ({
  isOriginAllowed: (origin: string) => origin === 'https://app.example.com',
  // Whole-module mock, so the real one is not here to fall back on.
  allowedOrigin: (req: Request) => {
    const origin = req.headers.get('origin')
    return origin === 'https://app.example.com' ? origin : null
  },
  getAllowedOrigins: () => ['https://app.example.com'],
  refreshIfStale: () => {},
  refreshCorsOrigins: async () => {},
}))

// Mock RAG tools — return a known result so we can test search_documentation tool
const mockSearchDocumentation = mock(async (_query: string, _limit?: number) => ({
  total_results: 1,
  documents: [
    {
      title: 'Test Doc',
      content: 'This is test documentation content.',
      source: 'test.md',
      similarity: 0.95,
    },
  ],
}))

mock.module('../src/lib/ai/rag-tools', () => ({
  searchDocumentation: mockSearchDocumentation,
}))

// Set env vars so the real config module returns the values we need.
// IMPORTANT: Do NOT mock.module('../src/config') — that replaces the entire
// singleton with a partial object, permanently stripping ial, accessControl,
// etc. for all subsequent test files in the same bun process.
process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
process.env.KEYCLOAK_PUBLIC_URL = 'http://localhost:8080'
process.env.KEYCLOAK_REALM = 'proxy-smart'

// Use the REAL mcp-endpoint-config module. Control it via saveMcpEndpointConfig
// in beforeEach. Do NOT mock.module('../src/lib/mcp-endpoint-config') — that
// permanently replaces the module for all subsequent test files in the same bun
// process, breaking mcp-endpoint-config.test.ts.
import { saveMcpEndpointConfig } from '../src/lib/mcp-endpoint-config'

// ── Import route after mocks are in place ────────────────────────────────────

import { Elysia } from 'elysia'

const { mcpEndpointRoutes } = await import('../src/routes/mcp-endpoint')

function createApp() {
  return new Elysia().use(mcpEndpointRoutes)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonRpcInitialize(id = 1) {
  return {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    },
    id,
  }
}

function mcpPost(
  body: unknown,
  opts: { token?: string; sessionId?: string; origin?: string } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (opts.origin) {
    headers['Origin'] = opts.origin
  }
  if (opts.token !== undefined) {
    headers['Authorization'] = `Bearer ${opts.token}`
  }
  if (opts.sessionId) {
    headers['Mcp-Session-Id'] = opts.sessionId
  }
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function mcpGet(opts: { token?: string; sessionId?: string } = {}) {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  }
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
  if (opts.sessionId) headers['Mcp-Session-Id'] = opts.sessionId
  return new Request('http://localhost/mcp', { method: 'GET', headers })
}

function mcpDelete(opts: { token?: string; sessionId?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
  if (opts.sessionId) headers['Mcp-Session-Id'] = opts.sessionId
  return new Request('http://localhost/mcp', { method: 'DELETE', headers })
}

/**
 * Parse an SSE or JSON response body into JSON-RPC message(s).
 * The MCP SDK may return `text/event-stream` for request responses.
 */
async function parseResponse(res: Response): Promise<Record<string, unknown>> {
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/event-stream')) {
    const text = await res.text()
    const messages: Record<string, unknown>[] = []
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          messages.push(JSON.parse(line.slice(6)))
        } catch {
          /* skip */
        }
      }
    }
    // Prefer the last JSON-RPC response (has `id`)
    const response = [...messages].reverse().find((m) => m.id !== undefined)
    return response ?? messages[0] ?? (() => { throw new Error(`No data in SSE: ${text}`) })()
  }
  return res.json()
}

/**
 * The endpoint is STATELESS: each POST is served by a fresh server + transport,
 * so there is no handshake to carry forward and no session id to thread through.
 * Kept as a helper so the tests still read as "given an initialized client".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initializeSession(app: any, token = 'valid-token') {
  const initRes = await app.handle(mcpPost(jsonRpcInitialize(), { token }))
  expect(initRes.status).toBe(200)
  // The defining assertion of the stateless posture.
  expect(initRes.headers.get('mcp-session-id')).toBeNull()
  return { sessionId: undefined as string | undefined, initRes }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MCP Endpoint — /mcp', () => {
  beforeEach(() => {
    // Explicitly re-arm mock implementation — bun's mockClear may reset it
    mockValidateToken.mockClear()
    mockValidateToken.mockImplementation(async (_token: string) => ({
      sub: 'test-user',
      azp: 'mcp-test-client',
      iss: 'http://localhost:8080/realms/proxy-smart',
      realm_access: { roles: ['admin'] },
      resource_access: {},
    }))
    mockSearchDocumentation.mockClear()
    // Reset the real mcp-endpoint-config to defaults via its public API
    saveMcpEndpointConfig({
      enabled: true,
      disabledTools: [],
      enabledTools: null,
      exposeResourcesAsTools: true,
      updatedAt: new Date().toISOString(),
    })
  })

  // ── Authentication (all HTTP methods) ──────────────────────────────────

  describe('Authentication', () => {
    it('POST: returns 401 when no Authorization header is provided', async () => {
      const app = createApp()
      const res = await app.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(jsonRpcInitialize()),
        }),
      )
      expect(res.status).toBe(401)
    })

    // Deliberately NOT pinning a JSON-RPC body here. Auth fails at the HTTP
    // layer, before JSON-RPC processing, and the spec's mechanism is the status
    // plus WWW-Authenticate. The old -32001 also sat in the -32000..-32099 range
    // the spec allocates from — SEP 2243 proposed -32001 for HeaderMismatch
    // before the shipped spec moved it to -32020.
    it('POST: 401 carries the challenge, not a JSON-RPC error body', async () => {
      const app = createApp()
      const res = await app.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(jsonRpcInitialize()),
        }),
      )
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('Bearer')
    })

    it('401 includes WWW-Authenticate with resource_metadata pointing to RFC 9728 URL', async () => {
      const app = createApp()
      const res = await app.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(jsonRpcInitialize()),
        }),
      )
      const wwwAuth = res.headers.get('WWW-Authenticate')
      expect(wwwAuth).toBeDefined()
      expect(wwwAuth).toContain('Bearer')
      expect(wwwAuth).toContain('resource_metadata=')
      expect(wwwAuth).toContain('http://localhost:8445/.well-known/oauth-protected-resource')
    })

    it('returns 401 when token validation throws', async () => {
      mockValidateToken.mockImplementationOnce(async () => {
        throw new Error('Token expired')
      })
      const app = createApp()
      const res = await app.handle(mcpPost(jsonRpcInitialize(), { token: 'expired-token' }))
      expect(res.status).toBe(401)
    })

    it('returns 401 for "Bearer " with empty token string', async () => {
      // Code should reject empty tokens before calling validateToken
      const app = createApp()
      const res = await app.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ',
          },
          body: JSON.stringify(jsonRpcInitialize()),
        }),
      )
      expect(res.status).toBe(401)
    })

    it('returns 401 for Basic auth scheme (wrong scheme)', async () => {
      const app = createApp()
      const res = await app.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic dXNlcjpwYXNz',
          },
          body: JSON.stringify(jsonRpcInitialize()),
        }),
      )
      expect(res.status).toBe(401)
    })

    // Discovery depends on this: an MCP client registering against the endpoint
    // makes an unauthenticated request and follows the challenge. A 405 without
    // WWW-Authenticate leaves it nothing to follow, which broke connectors.
    it('GET: 401 with a challenge, so discovery works', async () => {
      const app = createApp()
      const res = await app.handle(mcpGet())
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
    })

    it('DELETE: 401 with a challenge, so discovery works', async () => {
      const app = createApp()
      const res = await app.handle(mcpDelete())
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
    })
  })

  // ── Disabled endpoint ────────────────────────────────────────────────────
  // The file-backed config is the single source of truth. When it disables MCP,
  // the endpoint returns 404. (The beforeEach re-arms enabled: true before each test.)

  describe('Origin validation (DNS rebinding)', () => {
    // MCP Streamable HTTP, Security Warning: servers MUST validate Origin on all
    // incoming connections and MUST answer 403 when it is present and invalid.
    // A CORS policy is not enough — it only makes the response unreadable, while
    // the request still executes.

    it('refuses a disallowed Origin with 403, before authentication', async () => {
      const app = createApp()
      const res = await app.handle(
        // A valid token: the 403 must not depend on the request being unauthenticated.
        mcpPost(jsonRpcInitialize(), { token: 'valid-token', origin: 'https://evil.example.com' }),
      )

      expect(res.status).toBe(403)
      const body = await res.json() as Record<string, unknown>
      expect((body.error as Record<string, unknown>).message).toContain('Origin')
    })

    it('allows a permitted Origin', async () => {
      const app = createApp()
      const res = await app.handle(
        mcpPost(jsonRpcInitialize(), { token: 'valid-token', origin: 'https://app.example.com' }),
      )

      expect(res.status).toBe(200)
    })

    it('allows a request with no Origin at all (non-browser client)', async () => {
      const app = createApp()
      const res = await app.handle(mcpPost(jsonRpcInitialize(), { token: 'valid-token' }))

      expect(res.status).toBe(200)
    })

    it('refuses a disallowed Origin even without a token', async () => {
      const app = createApp()
      const res = await app.handle(
        mcpPost(jsonRpcInitialize(), { origin: 'https://evil.example.com' }),
      )

      // 403, not the 401 the missing token would otherwise produce.
      expect(res.status).toBe(403)
    })
  })

  describe('Disabled endpoint', () => {
    it('returns 404 when file-config disables MCP', async () => {
      saveMcpEndpointConfig({ enabled: false, disabledTools: [], enabledTools: null, exposeResourcesAsTools: true, updatedAt: new Date().toISOString() })
      const app = createApp()
      const res = await app.handle(mcpPost(jsonRpcInitialize(), { token: 'valid-token' }))
      expect(res.status).toBe(404)
    })

    it('returns 404 response body is JSON with error message', async () => {
      saveMcpEndpointConfig({ enabled: false, disabledTools: [], enabledTools: null, exposeResourcesAsTools: true, updatedAt: new Date().toISOString() })
      const app = createApp()
      const res = await app.handle(mcpPost(jsonRpcInitialize(), { token: 'valid-token' }))
      const body = await res.json()
      expect(body.error).toBeDefined()
    })

    it('is disabled when file-config is disabled', async () => {
      // Admin UI toggled off → endpoint is disabled
      saveMcpEndpointConfig({ enabled: false, disabledTools: [], enabledTools: null, exposeResourcesAsTools: true, updatedAt: new Date().toISOString() })
      const app = createApp()
      const res = await app.handle(mcpPost(jsonRpcInitialize(), { token: 'valid-token' }))
      expect(res.status).toBe(404)
    })
  })

  // ── Session lifecycle ────────────────────────────────────────────────────

  describe('Request lifecycle', () => {
    it('initialize returns JSON-RPC result with serverInfo and protocolVersion', async () => {
      const app = createApp()
      const res = await app.handle(mcpPost(jsonRpcInitialize(), { token: 'valid-token' }))
      const body = await parseResponse(res)
      expect(body.jsonrpc).toBe('2.0')
      expect(body.id).toBe(1)
      expect(body.result).toBeDefined()
      const result = body.result as Record<string, unknown>
      expect(result.protocolVersion).toBe('2025-03-26')
      const serverInfo = result.serverInfo as Record<string, unknown>
      expect(typeof serverInfo.name).toBe('string')
      expect((serverInfo.name as string).length).toBeGreaterThan(0)
      expect(typeof serverInfo.version).toBe('string')
      expect((serverInfo.version as string).length).toBeGreaterThan(0)
    })

    it('initialize response declares tools and resources capabilities', async () => {
      const app = createApp()
      const res = await app.handle(mcpPost(jsonRpcInitialize(), { token: 'valid-token' }))
      const body = await parseResponse(res)
      const result = body.result as Record<string, unknown>
      const capabilities = result.capabilities as Record<string, unknown>
      expect(capabilities.tools).toBeDefined()
      expect(capabilities.resources).toBeDefined()
    })

    it('accepts ping on an established session', async () => {
      const app = createApp()
      const { sessionId } = await initializeSession(app)

      const pingRes = await app.handle(
        mcpPost(
          { jsonrpc: '2.0', method: 'ping', id: 2 },
          { token: 'valid-token', sessionId },
        ),
      )
      expect(pingRes.status).toBe(200)
      const body = await parseResponse(pingRes)
      expect(body.jsonrpc).toBe('2.0')
      expect(body.id).toBe(2)
      expect(body.result).toBeDefined()
    })

    it('tools/list works after full handshake and returns registered tools', async () => {
      const app = createApp()
      const { sessionId } = await initializeSession(app)

      const listRes = await app.handle(
        mcpPost(
          { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 3 },
          { token: 'valid-token', sessionId },
        ),
      )
      expect(listRes.status).toBe(200)
      const body = await parseResponse(listRes)
      expect(body.jsonrpc).toBe('2.0')
      expect(body.id).toBe(3)
      expect(body.result).toBeDefined()
      const result = body.result as Record<string, unknown>
      const tools = result.tools as Array<Record<string, unknown>>
      expect(Array.isArray(tools)).toBe(true)
      // search_documentation should always be registered
      const searchTool = tools.find((t) => t.name === 'search_documentation')
      expect(searchTool).toBeDefined()
      expect(searchTool!.description).toContain('documentation')
      // Every tool must have inputSchema (MCP spec)
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined()
      }
    })

    it('search_documentation tool is callable via tools/call and returns content', async () => {
      const app = createApp()
      const { sessionId } = await initializeSession(app)

      const callRes = await app.handle(
        mcpPost(
          {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'search_documentation',
              arguments: { query: 'SMART on FHIR', limit: 3 },
            },
            id: 4,
          },
          { token: 'valid-token', sessionId },
        ),
      )
      expect(callRes.status).toBe(200)
      const body = await parseResponse(callRes)
      expect(body.jsonrpc).toBe('2.0')
      expect(body.id).toBe(4)
      const result = body.result as Record<string, unknown>
      const content = result.content as Array<Record<string, unknown>>
      expect(Array.isArray(content)).toBe(true)
      expect(content.length).toBeGreaterThan(0)
      expect(content[0].type).toBe('text')
      // Should contain the mock doc content
      expect(content[0].text).toContain('Test Doc')
      // Verify the mock was called with correct args
      expect(mockSearchDocumentation).toHaveBeenCalledWith('SMART on FHIR', 3)
    })

    it('tools/call with unknown tool name returns a JSON-RPC protocol error', async () => {
      const app = createApp()
      const { sessionId } = await initializeSession(app)

      const callRes = await app.handle(
        mcpPost(
          {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'nonexistent_tool_xyz',
              arguments: {},
            },
            id: 5,
          },
          { token: 'valid-token', sessionId },
        ),
      )
      expect(callRes.status).toBe(200)
      const body = await parseResponse(callRes)
      // An unknown tool is a PROTOCOL error, not a tool-execution error: the spec
      // (2026-07-28, Tools > Error Handling) lists "Unknown tool" under protocol
      // errors returned as a JSON-RPC error with code -32602, and reserves
      // `isError: true` in the result for failures a model can self-correct from.
      // SDK v1 returned the isError form here; v2 returns the spec form.
      expect(body.result).toBeUndefined()
      const error = body.error as Record<string, unknown>
      expect(error).toBeDefined()
      expect(error.code).toBe(-32602)
      expect(String(error.message)).toContain('nonexistent_tool_xyz')
    })

    it('token is refreshed on each request via tokenRef', async () => {
      const app = createApp()
      const { sessionId } = await initializeSession(app, 'token-v1')

      // Second request with a different token
      const pingRes = await app.handle(
        mcpPost(
          { jsonrpc: '2.0', method: 'ping', id: 2 },
          { token: 'token-v2', sessionId },
        ),
      )
      expect(pingRes.status).toBe(200)
      // validateToken was called with both tokens
      const calls = mockValidateToken.mock.calls.map((c) => c[0])
      expect(calls).toContain('token-v1')
      expect(calls).toContain('token-v2')
    })
  })

  // ── DELETE /mcp (session teardown) ───────────────────────────────────────
  // Spec: "Clients that no longer need a particular session SHOULD send an HTTP DELETE
  //        to the MCP endpoint with the Mcp-Session-Id header"

  describe('Stateless posture', () => {
    // The endpoint used to hold transports in PROCESS MEMORY keyed by
    // Mcp-Session-Id. Every deploy invalidated every live connection and the next
    // request got 404 Session not found — on an environment that redeploys many
    // times a day, that is most of them. SEP-2575 removes the model entirely.

    it('never mints an Mcp-Session-Id', async () => {
      const app = createApp()
      const res = await app.handle(mcpPost(jsonRpcInitialize(), { token: 'valid-token' }))
      expect(res.status).toBe(200)
      expect(res.headers.get('mcp-session-id')).toBeNull()
    })

    it('serves a request with no prior handshake at all', async () => {
      // The property that makes redeploys survivable: a request carries
      // everything needed to serve it.
      const app = createApp()
      const res = await app.handle(
        mcpPost({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 7 }, { token: 'valid-token' }),
      )
      expect(res.status).toBe(200)
      const body = await parseResponse(res)
      const result = body.result as { tools?: unknown[] }
      expect(Array.isArray(result.tools)).toBe(true)
    })

    it('ignores a stale Mcp-Session-Id rather than 404ing on it', async () => {
      // A client reconnecting after a deploy still holds the old id. It must not
      // be punished for that — there is nothing to look up any more.
      const app = createApp()
      const res = await app.handle(
        mcpPost({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 8 }, {
          token: 'valid-token',
          sessionId: 'a-session-that-died-with-the-last-deploy',
        }),
      )
      expect(res.status).toBe(200)
    })

    it('answers GET (standalone stream) with 405 and Allow: POST', async () => {
      // Spec-sanctioned and benign: the client proceeds without the stream.
      const app = createApp()
      const res = await app.handle(mcpGet({ token: 'valid-token' }))
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toContain('POST')
    })

    it('answers DELETE (session teardown) with 405', async () => {
      const app = createApp()
      const res = await app.handle(mcpDelete({ token: 'valid-token' }))
      expect(res.status).toBe(405)
    })

    it('two initializations are independent', async () => {
      const app = createApp()
      const a = await app.handle(mcpPost(jsonRpcInitialize(1), { token: 'valid-token' }))
      const b = await app.handle(mcpPost(jsonRpcInitialize(2), { token: 'valid-token' }))
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      expect(a.headers.get('mcp-session-id')).toBeNull()
      expect(b.headers.get('mcp-session-id')).toBeNull()
    })
  })

  describe('JSON-RPC batch', () => {
    it('accepts a JSON-RPC batch array on an established session', async () => {
      const app = createApp()
      const { sessionId } = await initializeSession(app)

      const batchRes = await app.handle(
        mcpPost(
          [
            { jsonrpc: '2.0', method: 'ping', id: 10 },
            { jsonrpc: '2.0', method: 'ping', id: 11 },
          ],
          { token: 'valid-token', sessionId },
        ),
      )
      // Batch should be accepted (200)
      expect(batchRes.status).toBe(200)
    })
  })
})

// ── Path Parameter Extraction (unit) ─────────────────────────────────────────

describe('MCP Endpoint — Path Parameter Extraction', () => {
  // Replicates the extractPathParams logic (not exported) for unit testing
  function extractPathParams(path: string, args: Record<string, unknown>): Record<string, string> {
    const params: Record<string, string> = {}
    const paramNames = path.match(/:(\w+)/g)
    if (paramNames) {
      for (const param of paramNames) {
        const name = param.slice(1)
        if (args[name] !== undefined) {
          params[name] = String(args[name])
        }
      }
    }
    return params
  }

  it('extracts single path param and removes it from body args', () => {
    const path = '/admin/users/:userId'
    const args: Record<string, unknown> = { userId: '123', name: 'John', email: 'john@example.com' }
    const params = extractPathParams(path, args)
    expect(params).toEqual({ userId: '123' })

    const bodyArgs = { ...args }
    for (const key of Object.keys(params)) delete bodyArgs[key]
    expect(bodyArgs).toEqual({ name: 'John', email: 'john@example.com' })
  })

  it('extracts multiple path params', () => {
    const path = '/admin/groups/:groupId/members/:memberId'
    const args = { groupId: 'g1', memberId: 'm1', role: 'editor' }
    const params = extractPathParams(path, args)
    expect(params).toEqual({ groupId: 'g1', memberId: 'm1' })
  })

  it('returns empty object for routes with no path params', () => {
    const params = extractPathParams('/admin/restart', { force: true })
    expect(params).toEqual({})
  })

  it('converts numeric values to strings', () => {
    const params = extractPathParams('/admin/items/:itemId', { itemId: 42 })
    expect(params.itemId).toBe('42')
    expect(typeof params.itemId).toBe('string')
  })

  it('handles missing path param in args gracefully', () => {
    const params = extractPathParams('/admin/users/:userId', { name: 'John' })
    expect(params).toEqual({})
  })

  it('handles undefined value for path param', () => {
    const params = extractPathParams('/admin/users/:userId', { userId: undefined, name: 'John' })
    expect(params).toEqual({})
  })
})
