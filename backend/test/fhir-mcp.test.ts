// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Per-server FHIR MCP endpoint — /fhir/:server_id/mcp
 *
 * The endpoint had no tests while it hand-rolled its own HTTP edge. It now
 * delegates that edge to @maxhealth.tech/mcp-http, so these pin the behaviour
 * the migration has to preserve: the server gate stays local, and the Origin,
 * Bearer and method gates come from the library in the right order.
 */

import { describe, it, expect, mock } from 'bun:test'

const mockValidateToken = mock(async (token: string, _options?: { enforceAudience?: boolean }) => {
  if (token === 'bad-token') throw new Error('invalid')
  return { sub: 'test-user', iss: 'http://localhost:8080/realms/proxy-smart' }
})

mock.module('../src/lib/auth', () => ({ validateToken: mockValidateToken }))

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

mock.module('../src/lib/fhir-server-store', () => ({
  ensureServersInitialized: async () => {},
  getServerInfoByName: async (name: string) => {
    if (name === 'enabled') return { name, mcpEnabled: true }
    if (name === 'disabled') return { name, mcpEnabled: false }
    return null
  },
}))

mock.module('../src/lib/ai/fhir-tools', () => ({
  registerFhirToolsForServer: () => {},
}))

const { fhirMcpRoutes } = await import('../src/routes/fhir-mcp')

const URL_ENABLED = 'http://localhost:8445/fhir/enabled/mcp'

function post(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  })
}

const call = (req: Request) => fhirMcpRoutes.handle(req)

describe('FHIR MCP endpoint — server gate', () => {
  it('returns 404 for an unknown server', async () => {
    const res = await call(post('http://localhost:8445/fhir/nope/mcp'))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('not_found')
  })

  it('returns 403 when the server has MCP disabled', async () => {
    const res = await call(post('http://localhost:8445/fhir/disabled/mcp'))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('mcp_disabled')
  })

  it('resolves the server before any auth check', async () => {
    // No Authorization header: a 404 here proves the server gate runs first.
    const res = await call(post('http://localhost:8445/fhir/nope/mcp'))
    expect(res.status).toBe(404)
  })
})

describe('FHIR MCP endpoint — Origin gate (DNS rebinding)', () => {
  it('refuses a disallowed Origin', async () => {
    const res = await call(post(URL_ENABLED, { Origin: 'https://evil.example.com' }))
    expect(res.status).toBe(403)
  })

  it('refuses a disallowed Origin even without a token', async () => {
    const res = await call(
      new Request(URL_ENABLED, { method: 'POST', headers: { Origin: 'https://evil.example.com' } }),
    )
    expect(res.status).toBe(403)
  })

  it('allows a permitted Origin through to the auth gate', async () => {
    const res = await call(post(URL_ENABLED, { Origin: 'https://app.example.com' }))
    expect(res.status).toBe(401)
  })

  it('allows a request with no Origin at all (non-browser client)', async () => {
    const res = await call(post(URL_ENABLED))
    expect(res.status).not.toBe(403)
  })
})

describe('FHIR MCP endpoint — Bearer gate', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await call(post(URL_ENABLED))
    expect(res.status).toBe(401)
  })

  it('401 carries an RFC 9728 resource_metadata pointer', async () => {
    const res = await call(post(URL_ENABLED))
    const challenge = res.headers.get('www-authenticate') ?? ''
    expect(challenge).toContain('Bearer')
    expect(challenge).toContain('resource_metadata=')
  })

  it('returns 401 when the token fails validation', async () => {
    const res = await call(post(URL_ENABLED, { Authorization: 'Bearer bad-token' }))
    expect(res.status).toBe(401)
  })

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await call(post(URL_ENABLED, { Authorization: 'Basic abc123' }))
    expect(res.status).toBe(401)
  })

  // Same tools over the same server as the FHIR proxy, so the same audience policy
  // (#355). The default matcher set describes the ADMIN /mcp endpoint, and applying
  // it here refused SMART tokens that REST accepts for the identical operations.
  it('validates the token under the FHIR proxy audience policy', async () => {
    mockValidateToken.mockClear()
    await call(post(URL_ENABLED, { Authorization: 'Bearer good-token' }))
    expect(mockValidateToken).toHaveBeenCalled()
    expect(mockValidateToken.mock.calls[0]?.[1]).toMatchObject({ enforceAudience: false })
  })
})

describe('FHIR MCP endpoint — discovery', () => {
  // A 405 without WWW-Authenticate leaves a registering client nothing to
  // follow. Discovery has to work on any method.
  it.each(['GET', 'DELETE'])('%s without a token gets a challenge, not 405', async (method) => {
    const res = await call(new Request(URL_ENABLED, { method }))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  it.each(['GET', 'DELETE'])('%s with a token is refused as stateless', async (method) => {
    const res = await call(
      new Request(URL_ENABLED, { method, headers: { Authorization: 'Bearer good-token' } }),
    )
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain('POST')
  })
})

describe('FHIR MCP endpoint — deprecation', () => {
  const urls = [URL_ENABLED, 'http://localhost:8445/fhir/disabled/mcp', 'http://localhost:8445/fhir/unknown/mcp']

  it.each(urls)('announces the deprecation and sunset on every answer from %s', async (url) => {
    const res = await call(post(url))
    expect(res.headers.get('deprecation')).toMatch(/^@\d+$/)
    expect(Date.parse(res.headers.get('sunset') ?? '')).toBeGreaterThan(Date.now())
    expect(res.headers.get('link')).toContain('rel="deprecation"')
  })

  it('keeps the answer itself unchanged', async () => {
    const res = await call(post(URL_ENABLED))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
  })
})
