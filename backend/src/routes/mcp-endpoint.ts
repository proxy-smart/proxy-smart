// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * MCP Streamable HTTP Endpoint
 *
 * Exposes the backend's tool-registry as a proper MCP server using the
 * Streamable HTTP transport from @modelcontextprotocol/server.
 *
 * Auth: MCP clients discover OAuth via RFC 9728, login via Keycloak, pass Bearer token.
 * The handler validates the token on every request. Unauthenticated requests
 * receive a 401 with a `WWW-Authenticate` header pointing at the protected
 * resource metadata URL so compliant clients can trigger the OAuth flow.
 *
 * Mounted at `config.mcp.path` (default `/mcp`) via app-factory.
 */

import { Elysia } from 'elysia'
import * as z from 'zod'
import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHttpHandler } from '@maxhealth.tech/mcp-http'
import { allowedOrigin, isOriginAllowed } from '@/lib/cors-origins'

import { registerRouteTools, registerRouteResources } from '@maxhealth.tech/elysia-mcp'
import { prefabView, uiToolMeta } from '@maxhealth.tech/elysia-mcp/prefab'
import { registerViewerResource } from '@maxhealth.tech/prefab'

import { config } from '../config'
import { validateToken } from '../lib/auth'
import { readKeycloakClaims } from '../lib/jwt-claims'
import { allRoles } from '../lib/admin-roles'
import { McpUnauthorizedError } from './mcp-unauthorized-error'
import { getMcpResourceAudience } from '../lib/token-audience'
import {
  getToolRegistry,
  isToolRegistryInitialized,
  getResourceRegistry,
  isResourceRegistryInitialized,
  PROXY_SMART_RESOURCE_SCHEME,
  requireDispatchApp,
} from '../lib/ai/tool-registry'
import { loadMcpEndpointConfig, isToolExposed, isResourceExposed } from '../lib/mcp-endpoint-config'
import { MCP_SCOPE_CHALLENGE } from '../lib/oauth-scopes'
import { searchDocumentation } from '../lib/ai/rag-tools'
import { registerReadResourceTool } from '../lib/ai/read-resource-tool'
import { registerToolFormTool } from '../lib/ai/tool-form-tool'

// No session store: this endpoint is stateless (see handleMcpRequest). The
// SessionManager that used to live here held transports in PROCESS MEMORY, so
// every deploy silently invalidated every live connection and the next request
// got `404 Session not found` — on an environment that redeploys many times a
// day, that is most of them.

// 'auto' sends whichever of JSON and TOON is shorter; structuredContent stays JSON.
const TOOL_TEXT_OPTIONS = { textFormat: 'auto' } as const

// ── Tool bridging ────────────────────────────────────────────────────────────

function canSee(isPublic: boolean | undefined, userRoles: string[]): boolean {
  return isPublic === true || userRoles.includes('admin')
}

/** Mutation tools are registered individually; GET routes are served through `read_resource`. */
function registerTools(server: McpServer, userRoles: string[], tokenRef: { current?: string }): void {
  if (isToolRegistryInitialized()) {
    registerRouteTools(server, requireDispatchApp(), {
      tools: getToolRegistry(),
      authToken: tokenRef.current,
      filter: (name, meta) => isToolExposed(name) && !meta.readOnly && canSee(meta.public, userRoles),
      ...TOOL_TEXT_OPTIONS,
      ...(config.mcp.ui ? { view: prefabView(), toolMeta: uiToolMeta() } : {}),
    })
  }

  // RAG documentation search (domain-specific, not auto-generated)
  if (isToolExposed('search_documentation')) {
    server.registerTool(
      'search_documentation',
      {
        description:
          'Search the platform documentation knowledge base using semantic similarity. Use this when asked about platform features, configuration, SMART on FHIR concepts, admin UI, OAuth flows, or anything the docs might cover.',
        inputSchema: z.object({
                  query: z.string().describe('The search query to find relevant documentation'),
                  limit: z.number().optional().describe('Maximum number of results to return (default: 5)'),
                }),
      },
      async ({ query, limit }) => {
        try {
          const result = await searchDocumentation(query, limit ?? 5)
          if (result.total_results === 0) {
            return { content: [{ type: 'text' as const, text: 'No relevant documentation found.' }] }
          }
          const text = result.documents
            .map((doc) => `## ${doc.title}\n\n${doc.content}\n\n_Source: ${doc.source}_`)
            .join('\n\n---\n\n')
          return { content: [{ type: 'text' as const, text }] }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Documentation search failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          }
        }
      },
    )
  }

  // Unified read_resource tool (collapses GET route tools into one)
  const cfg = loadMcpEndpointConfig()
  if (cfg.exposeResourcesAsTools && isToolExposed('read_resource')) {
    registerReadResourceTool(server, userRoles, tokenRef)
  }

  // show_form draws a write tool's arguments as a form the user fills in.
  // Pointless without a host that renders it, hence the same flag as the views.
  if (config.mcp.ui && isToolExposed('show_form')) {
    registerToolFormTool(server, userRoles)
  }
}

// ── Resource bridging ────────────────────────────────────────────────────────

function registerResources(server: McpServer, userRoles: string[], tokenRef: { current?: string }): void {
  if (!isResourceRegistryInitialized()) return
  registerRouteResources(server, requireDispatchApp(), {
    resources: getResourceRegistry(),
    scheme: PROXY_SMART_RESOURCE_SCHEME,
    authToken: tokenRef.current,
    filter: (name, meta) => isResourceExposed(name) && canSee(meta.public, userRoles),
  })
}

// ── Auth helper ──────────────────────────────────────────────────────────────

interface AuthResult {
  roles: string[]
  sub?: string
  token?: string
}

/** Rewrites the 401 challenge with the trusted config.baseUrl pointer and the `scope` upstream omits. */
function withChallenge(res: Response): Response {
  if (res.status !== 401) return res
  const baseUrl = (config.baseUrl || 'http://localhost:8445').replace(/\/+$/, '')
  const headers = new Headers(res.headers)
  headers.set(
    'WWW-Authenticate',
    `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="${MCP_SCOPE_CHALLENGE}"`,
  )
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

async function authenticateToken(token: string): Promise<AuthResult> {
  try {
    // MCP resource audience, admin-ui and admin-service are accepted; SMART-app tokens (FHIR-base aud) are not.
    const mcpAudiences = [getMcpResourceAudience()]
    if (config.keycloak.adminUiClientId) mcpAudiences.push(config.keycloak.adminUiClientId)
    if (config.keycloak.adminClientId) mcpAudiences.push(config.keycloak.adminClientId)
    const payload = await validateToken(token, { audience: mcpAudiences })
    return { roles: allRoles(readKeycloakClaims(payload)), sub: payload.sub, token }
  } catch {
    throw new McpUnauthorizedError('Unauthorized')
  }
}

// ── Core request handler ─────────────────────────────────────────────────────

/** Built once; the tool registry is read per request inside createServer. */
let handler: ReturnType<typeof createMcpHttpHandler> | null = null

function mcpHandler() {
  if (handler) return handler
  // Fail closed: mcp-http reads an absent authorizationServer as a public
  // endpoint and drops the Bearer gate.
  handler = createMcpHttpHandler({
    mcpPath: config.mcp?.path ?? '/mcp',
    authorizationServer: config.keycloak.expectedIssuer ?? config.baseUrl,
    cors: { origin: allowedOrigin },
    createServer: async (token) => {
      const auth = await authenticateToken(token ?? '')
      const tokenRef = { current: auth.token }
      const server = new McpServer(
        { name: config.displayName, version: config.version },
        { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } } },
      )
      // The viewer is the `ui://` resource a host loads into its sandboxed
      // iframe before any tool runs; prefab owns its HTML, CSP and cache hints.
      // Registered before connect so the MCP Apps extension capability can be
      // declared with it.
      if (config.mcp.ui) registerViewerResource(server, { themeBridge: 'vscode' })
      // Filtered by the roles on THIS request's token.
      registerTools(server, auth.roles, tokenRef)
      registerResources(server, auth.roles, tokenRef)
      return server
    },
    // A createServer throw is a 500 upstream; a bad token deserves a 401.
    onError: (err) =>
      err instanceof McpUnauthorizedError
        ? new Response(null, { status: 401 })
        : undefined,
  })
  return handler
}

async function handleMcpRequest(request: Request): Promise<Response> {
  // Master switch — file-backed config is the single source of truth.
  if (!loadMcpEndpointConfig().enabled) {
    return Response.json({ error: 'MCP endpoint is disabled' }, { status: 404 })
  }

  // Origin still first: a rebound request must be REFUSED, not handed a
  // challenge it can act on.
  const origin = request.headers.get('origin')
  if (origin && !isOriginAllowed(origin)) {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Origin not allowed' }, id: null },
      { status: 403 },
    )
  }

  // Then the challenge, before the method gate. An MCP client discovers
  // authorization by making an UNAUTHENTICATED request and reading the 401's
  // WWW-Authenticate; upstream answers GET with 405 and no challenge, which
  // leaves a registering client with nothing to follow.
  if (!request.headers.get('authorization')) {
    return withChallenge(new Response(null, { status: 401 }))
  }

  return withChallenge(await mcpHandler()(request))
}

// ── Elysia route ─────────────────────────────────────────────────────────────

export const mcpEndpointRoutes = new Elysia({ tags: ['mcp-endpoint'] })
  .all('/mcp', ({ request }) => handleMcpRequest(request), {
    detail: {
      summary: 'MCP Streamable HTTP Endpoint',
      description:
        'Model Context Protocol endpoint (Streamable HTTP transport). ' +
        'Supports POST (tool calls / initialize), GET (SSE notifications), DELETE (session teardown). ' +
        'Requires Bearer token -- unauthenticated requests receive 401 with RFC 9728 discovery link.',
      tags: ['mcp-endpoint'],
    },
  })
