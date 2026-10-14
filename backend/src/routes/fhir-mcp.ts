// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Per-server FHIR MCP endpoint at `/fhir/{server_id}/mcp`, opt-in per server through `mcpEnabled`.
 * Deprecated: see FHIR_MCP_DEPRECATION. FHIR tools for agents belong in a FHIR MCP server.
 */

import { Elysia } from 'elysia'
import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHttpHandler, type McpHandler } from '@maxhealth.tech/mcp-http'
import { config } from '../config'
import { allowedOrigin, isOriginAllowed } from '../lib/cors-origins'
import { validateToken } from '../lib/auth'
import { getServerInfoByName, ensureServersInitialized } from '../lib/fhir-server-store'
import { registerFhirToolsForServer } from '../lib/ai/fhir-tools'
import { fhirMcpPath } from '../lib/mcp-resources'
import { logger } from '../lib/logger'
import { McpUnauthorizedError } from './mcp-unauthorized-error'

/** FHIR tools for agents belong in a dedicated FHIR MCP server, not in the authorization proxy. */
export const FHIR_MCP_DEPRECATION = {
  deprecatedAt: new Date(Date.UTC(2026, 9, 14)),
  sunset: new Date(Date.UTC(2027, 0, 31)),
  removedIn: '0.8.0',
  docs: 'https://proxy-smart.github.io/proxy-smart/MCP_HTTP_SERVER#per-server-fhir-mcp-deprecated',
} as const

/** RFC 9745 Deprecation, RFC 8594 Sunset and a deprecation link on an otherwise unchanged answer. */
function withDeprecation(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Deprecation', `@${Math.floor(FHIR_MCP_DEPRECATION.deprecatedAt.getTime() / 1000)}`)
  headers.set('Sunset', FHIR_MCP_DEPRECATION.sunset.toUTCString())
  headers.append('Link', `<${FHIR_MCP_DEPRECATION.docs}>; rel="deprecation"; type="text/html"`)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

// Stateless: each request is served by a fresh server bound to the bearer on
// THAT request. The HTTP edge is @maxhealth.tech/mcp-http, which tracks the
// 2026-07-28 protocol through the SDK's own handler.

/** `mcpPath` must match the mount exactly, and the mount is per-server. */
const handlers = new Map<string, McpHandler>()

function handlerFor(serverId: string): McpHandler {
  const existing = handlers.get(serverId)
  if (existing) return existing

  // Fail closed. mcp-http reads an absent authorizationServer as "public
  // endpoint" and drops the Bearer gate, so an unconfigured issuer must not be
  // allowed to reach it.
  const authorizationServer = config.keycloak.expectedIssuer ?? config.baseUrl

  const handler = createMcpHttpHandler({
    mcpPath: `/fhir/${serverId}/mcp`,
    authorizationServer,
    cors: { origin: allowedOrigin },
    createServer: async (token) => {
      // Proven good before it is forwarded to FHIR as this request's identity.
      // Audience unenforced, as on the FHIR proxy this wraps (#355): the same tools
      // over the same server, so a stricter door here refuses only clients that can
      // do the identical operations over REST with the identical token.
      try {
        await validateToken(token ?? '', { enforceAudience: false })
      } catch {
        throw new McpUnauthorizedError('Invalid or expired token')
      }

      const server = new McpServer({
        name: `proxy-smart-fhir-${serverId}`,
        version: config.version || '1.0.0',
      })
      // Scoped to this server, and to the scopes on THIS request's token.
      registerFhirToolsForServer(server, { current: token ?? undefined }, serverId)
      return server
    },
    // A createServer throw is a 500 upstream; a bad token deserves a 401.
    onError: (err) =>
      err instanceof McpUnauthorizedError
        ? new Response(
            JSON.stringify({ error: 'unauthorized', message: err.message }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        : undefined,
  })

  handlers.set(serverId, handler)
  logger.fhir.warn('Serving the deprecated per-server FHIR MCP endpoint', {
    serverId,
    removedIn: FHIR_MCP_DEPRECATION.removedIn,
    sunset: FHIR_MCP_DEPRECATION.sunset.toISOString(),
  })
  return handler
}

// ── Route ────────────────────────────────────────────────────────────────────

export const fhirMcpRoutes = new Elysia()
  .all('/fhir/:server_id/mcp', async ({ params, request }) => withDeprecation(await serve(params.server_id, request)))

async function serve(server_id: string, request: Request): Promise<Response> {
  // Settled before the protocol handler: both answers are about the server.
  await ensureServersInitialized()

  const serverInfo = await getServerInfoByName(server_id)
  if (!serverInfo) {
    return Response.json(
      { error: 'not_found', message: `FHIR server '${server_id}' not found` },
      { status: 404 },
    )
  }
  if (!serverInfo.mcpEnabled) {
    return Response.json(
      { error: 'mcp_disabled', message: `MCP endpoint is not enabled for server '${server_id}'` },
      { status: 403 },
    )
  }

  // Origin first: a rebound request must be refused, not challenged.
  const origin = request.headers.get('origin')
  if (origin && !isOriginAllowed(origin)) {
    return new Response(null, { status: 403 })
  }

  // Then the challenge, before the method gate. A client discovers
  // authorization from an unauthenticated request; upstream answers GET with
  // 405 and no WWW-Authenticate, leaving it nothing to follow.
  if (!request.headers.get('authorization')) {
    const baseUrl = (config.baseUrl || 'http://localhost:8445').replace(/\/+$/, '')
    return new Response(null, {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${fhirMcpPath(server_id)}"`,
      },
    })
  }

  return handlerFor(server_id)(request)
}
