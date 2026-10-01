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
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { createMcpHttpHandler } from '@maxhealth.tech/mcp-http'
import { allowedOrigin, isOriginAllowed } from '@/lib/cors-origins'

import {
  typeboxToSchema,
  typeboxToOutputSchema,
  executeTool as pkgExecuteTool,
  executeResource as pkgExecuteResource,
  getMergedInputSchema,
  describeTool,
} from '@proxy-smart/elysia-mcp'
import type { ExecuteOptions, ResourceMetadata } from '@proxy-smart/elysia-mcp'
import { prefabView, uiToolMeta } from '@proxy-smart/elysia-mcp/prefab'
import { registerViewerResource } from '@maxhealth.tech/prefab'

import { config } from '../config'
import { validateToken } from '../lib/auth'
import { getMcpResourceAudience } from '../lib/token-audience'
import {
  getToolRegistry,
  isToolRegistryInitialized,
  getResourceRegistry,
  isResourceRegistryInitialized,
  pathToResourceUri,
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

// Admin list endpoints are the high-token responses an agent hits most, and are
// uniform enough for TOON's tabular form to collapse the repeated keys. 'auto'
// emits whichever of JSON and TOON is shorter per payload, so the nested and
// single-object responses TOON handles badly keep their JSON. structuredContent
// stays JSON either way.
const TOOL_TEXT_OPTIONS = { textFormat: 'auto' } as const

// ── Prefab UI (MCP Apps) ─────────────────────────────────────────────────────
//
// A tool result has one structuredContent and it cannot mean two things. With
// the UI on it carries the rendered view, which is where an MCP Apps host looks
// for it; the payload stays in the text block, which is what the model reads,
// so the UI costs no tokens. The route's response schema is then NOT advertised
// as outputSchema: the spec requires structured results to conform to a
// declared output schema, and a view does not. Off by default (MCP_PREFAB_UI),
// so the machine-facing contract is unchanged until a deployment asks for UI.

/** Execution options for this request's tool calls. */
function toolExecuteOptions(): ExecuteOptions {
  return config.mcp.ui
    ? { ...TOOL_TEXT_OPTIONS, view: prefabView() }
    : { ...TOOL_TEXT_OPTIONS }
}

// ── Tool bridging ────────────────────────────────────────────────────────────

/**
 * Register all exposed tools from the tool-registry onto an McpServer instance.
 * Mutation tools (POST/PUT/DELETE) are registered individually.
 * GET (read-only) tools are collapsed into a single `read_resource` tool.
 */
function registerTools(server: McpServer, userRoles: string[], tokenRef: { current?: string }): void {
  const execOptions = toolExecuteOptions()
  const uiMeta = config.mcp.ui ? { _meta: uiToolMeta() } : {}
  if (isToolRegistryInitialized()) {
    const registry = getToolRegistry()

    for (const [toolName, meta] of registry) {
      if (!isToolExposed(toolName)) continue
      if (meta.readOnly) continue
      if (!meta.public && !userRoles.includes('admin')) continue

      const inputSchema = getMergedInputSchema(meta)
      const toolSchema = inputSchema ? typeboxToSchema(inputSchema) : undefined
      // Advertising the route's declared success-response schema is what turns
      // structuredContent from an untyped copy of the text block into something
      // a client can validate. Safe because Elysia coerces the response to this
      // same schema in the pipeline, so the body already conforms.
      const outputSchema = config.mcp.ui ? undefined : typeboxToOutputSchema(meta.responseSchema)
      const description = describeTool(toolName, meta)
      // Behavioural hints derived from the HTTP verb (destructiveHint for
      // delete_*, idempotentHint for update_*/PUT, etc.) so MCP clients can
      // flag destructive admin operations. See elysia-mcp `annotationsForMethod`.
      const annotations = meta.annotations

      if (toolSchema) {
        server.registerTool(
          toolName,
          { description, inputSchema: toolSchema, ...(outputSchema ? { outputSchema } : {}), annotations, ...uiMeta },
          async (args: unknown) =>
            pkgExecuteTool(toolName, meta, args as Record<string, unknown>, tokenRef.current, requireDispatchApp(), execOptions),
        )
      } else {
        server.registerTool(
          toolName,
          { description, ...(outputSchema ? { outputSchema } : {}), annotations, ...uiMeta },
          async () =>
            pkgExecuteTool(toolName, meta, {}, tokenRef.current, requireDispatchApp(), execOptions),
        )
      }
    }
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
          const result = await searchDocumentation(query, (limit as number | undefined) ?? 5)
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

  const registry = getResourceRegistry()

  for (const [resourceName, meta] of registry) {
    if (!isResourceExposed(resourceName)) continue
    if (!meta.public && !userRoles.includes('admin')) continue

    const uri = pathToResourceUri(meta.path)
    const description = generateResourceDescription(resourceName, meta)

    if (meta.pathParams.length === 0) {
      server.registerResource(
        resourceName,
        uri,
        { description, mimeType: 'application/json' },
        async () => {
          const result = await pkgExecuteResource(meta, {}, tokenRef.current, requireDispatchApp())
          return { contents: [{ uri, text: result }] }
        },
      )
    } else {
      const template = new ResourceTemplate(uri, { list: undefined })
      server.registerResource(
        resourceName,
        template,
        { description, mimeType: 'application/json' },
        async (reqUri, variables) => {
          const params: Record<string, string> = {}
          for (const p of meta.pathParams) {
            if (variables[p]) params[p] = String(variables[p])
          }
          const result = await pkgExecuteResource(meta, params, tokenRef.current, requireDispatchApp())
          return { contents: [{ uri: reqUri.href, text: result }] }
        },
      )
    }
  }
}

// ── Description generators ───────────────────────────────────────────────────

function generateResourceDescription(name: string, meta: ResourceMetadata): string {
  const parts = name.split('_')
  return `Read ${parts.join(' ')}. ${meta.public ? '(Public)' : '(Admin only)'}`
}

// ── Auth helper ──────────────────────────────────────────────────────────────

interface AuthResult {
  roles: string[]
  sub?: string
  token?: string
}

/** A token that fails validation. Mapped to a 401 in `onError`. */
class McpUnauthorizedError extends Error {}

/** mcp-http wants the origin to echo, or null to refuse. No Origin stays allowed. */
/**
 * Rewrite the 401 challenge on the way out.
 *
 * Two things upstream does not do. It derives the pointer from `req.url`, so a
 * spoofed Host behind a proxy that does not normalise it would aim the client at
 * an attacker's metadata; config.baseUrl is trusted. And it omits `scope`, which
 * is what lets a client following the challenge actually authorize.
 */
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
    // MCP tokens are bound to the MCP endpoint resource (RFC 8707) or one of the
    // proxy's own clients (matched on aud/azp): the admin WEBAPP client
    // (admin-ui) and the backend admin-REST service account (admin-service). A
    // patient-facing SMART-app token (FHIR-base aud) is rejected. NB: admin-ui
    // must be accepted independently of adminClientId, which on beta/prod is the
    // service account (admin-service) — see validateAdminToken for the same fix.
    const mcpAudiences = [getMcpResourceAudience()]
    if (config.keycloak.adminUiClientId) mcpAudiences.push(config.keycloak.adminUiClientId)
    if (config.keycloak.adminClientId) mcpAudiences.push(config.keycloak.adminClientId)
    const payload = await validateToken(token, { audience: mcpAudiences })
    const realmRoles: string[] = (payload as Record<string, unknown> & { realm_access?: { roles?: string[] } }).realm_access?.roles ?? []
    const clientRoles: string[] = Object.values(
      (payload as Record<string, unknown> & { resource_access?: Record<string, { roles?: string[] }> }).resource_access ?? {},
    ).flatMap((r) => r?.roles ?? [])
    return { roles: [...new Set([...realmRoles, ...clientRoles])], sub: payload.sub, token }
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
