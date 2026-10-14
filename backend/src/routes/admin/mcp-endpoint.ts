// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Admin routes for the built-in MCP endpoint configuration.
 *
 * Lets admins:
 *  - GET  /admin/mcp-endpoint              → current config + available tools
 *  - PATCH /admin/mcp-endpoint             → update enabled / tool lists
 *  - PUT /admin/mcp-endpoint/tools/:name   → toggle a single tool on/off
 */

import { Elysia, t } from 'elysia'
import { validateToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { ErrorResponse, McpEndpointStatusResponse, McpEndpointUpdateBody } from '@/schemas'
import {
  loadMcpEndpointConfig,
  saveMcpEndpointConfig,
  type McpEndpointConfig,
} from '@/lib/mcp-endpoint-config'
import { getToolRegistry, isToolRegistryInitialized, generateToolDefinitions, getResourceRegistry, isResourceRegistryInitialized, proxySmartResourceUri } from '@/lib/ai/tool-registry'
import { describeResource } from '@maxhealth.tech/elysia-mcp'
import { config } from '@/config'

// ── Route ────────────────────────────────────────────────────────────────────

export const mcpEndpointAdminRoutes = new Elysia({
  prefix: '/mcp-endpoint',
  tags: ['mcp-management'],
})
  /**
   * Get current MCP endpoint status + tool list
   */
  .get('/', async ({ headers }) => {
    const authHeader = headers['authorization']
    if (!authHeader?.startsWith('Bearer ')) throw new Error('Unauthorized')
    await validateToken(authHeader.substring(7))

    const cfg = loadMcpEndpointConfig()
    const tools = buildToolList(cfg)
    const resources = buildResourceList(cfg)

    // File-backed config is the single source of truth
    return {
      enabled: cfg.enabled,
      configSource: 'file',
      endpointPath: config.mcp.path,
      endpointUrl: `${config.baseUrl}${config.mcp.path}`,
      tools,
      resources,
      disabledTools: cfg.disabledTools,
      enabledTools: cfg.enabledTools,
      exposeResourcesAsTools: cfg.exposeResourcesAsTools,
      updatedAt: cfg.updatedAt,
    }
  }, {
    detail: {
      summary: 'Get MCP endpoint status',
      description: 'Returns the current MCP endpoint configuration including which tools are exposed.',
      tags: ['mcp-management'],
    },
    response: { 200: McpEndpointStatusResponse, 401: ErrorResponse },
  })

  /**
   * Update MCP endpoint configuration
   */
  .patch('/', async ({ headers, body }) => {
    const authHeader = headers['authorization']
    if (!authHeader?.startsWith('Bearer ')) throw new Error('Unauthorized')
    await validateToken(authHeader.substring(7))

    const update = body as typeof McpEndpointUpdateBody.static
    const cfg = loadMcpEndpointConfig()

    if (update.enabled !== undefined) cfg.enabled = update.enabled
    if (update.disabledTools !== undefined) cfg.disabledTools = update.disabledTools
    if (update.enabledTools !== undefined) cfg.enabledTools = update.enabledTools
    if (update.exposeResourcesAsTools !== undefined) cfg.exposeResourcesAsTools = update.exposeResourcesAsTools

    await saveMcpEndpointConfig(cfg)
    logger.server.info('MCP endpoint config updated', {
      enabled: cfg.enabled,
      disabledToolCount: cfg.disabledTools.length,
      enabledToolCount: cfg.enabledTools?.length ?? 'all',
    })

    const tools = buildToolList(cfg)
    const resources = buildResourceList(cfg)

    // File-backed config is the single source of truth
    return {
      enabled: cfg.enabled,
      configSource: 'file',
      endpointPath: config.mcp.path,
      endpointUrl: `${config.baseUrl}${config.mcp.path}`,
      tools,
      resources,
      disabledTools: cfg.disabledTools,
      enabledTools: cfg.enabledTools,
      exposeResourcesAsTools: cfg.exposeResourcesAsTools,
      updatedAt: cfg.updatedAt,
    }
  }, {
    body: McpEndpointUpdateBody,
    detail: {
      summary: 'Update MCP endpoint configuration',
      description: 'Enable/disable the MCP endpoint or change which tools are exposed.',
      tags: ['mcp-management'],
    },
    response: { 200: McpEndpointStatusResponse, 401: ErrorResponse },
  })

  /**
   * Toggle a single tool's exposure on/off.
   * PUT /admin/mcp-endpoint/tools/:toolName { exposed: true/false }
   */
  .put('/tools/:toolName', async ({ headers, params, body }) => {
    const authHeader = headers['authorization']
    if (!authHeader?.startsWith('Bearer ')) throw new Error('Unauthorized')
    await validateToken(authHeader.substring(7))

    const { toolName } = params
    const { exposed } = body
    const cfg = loadMcpEndpointConfig()

    if (cfg.enabledTools !== null) {
      // Allowlist mode: add or remove from enabledTools
      const set = new Set(cfg.enabledTools)
      if (exposed) set.add(toolName)
      else set.delete(toolName)
      cfg.enabledTools = Array.from(set)
    } else {
      // Blocklist mode: add or remove from disabledTools
      const set = new Set(cfg.disabledTools)
      if (exposed) set.delete(toolName)
      else set.add(toolName)
      cfg.disabledTools = Array.from(set)
    }

    await saveMcpEndpointConfig(cfg)
    logger.server.info('MCP tool toggled', { toolName, exposed })

    return { toolName, exposed, updatedAt: cfg.updatedAt }
  }, {
    body: t.Object({
      exposed: t.Boolean({ description: 'Whether the tool should be exposed to MCP clients' }),
    }),
    detail: {
      summary: 'Toggle a single MCP tool',
      description: 'Enable or disable a specific tool by name without replacing the entire list.',
      tags: ['mcp-management'],
    },
    response: {
      200: t.Object({
        toolName: t.String(),
        exposed: t.Boolean(),
        updatedAt: t.String(),
      }),
      401: ErrorResponse,
    },
  })

// ── helpers ──────────────────────────────────────────────────────────────────

function buildToolList(cfg: McpEndpointConfig) {
  if (!isToolRegistryInitialized()) return []

  const registry = getToolRegistry()
  const defs = generateToolDefinitions(registry, ['admin'])

  const tools = defs.map((d) => {
    const name = d.function.name
    const meta = registry.get(name)
    let exposed: boolean
    if (cfg.enabledTools !== null) {
      exposed = cfg.enabledTools.includes(name)
    } else {
      exposed = !cfg.disabledTools.includes(name)
    }
    return { name, description: d.function.description, exposed, readOnly: meta?.readOnly || false }
  })

  // Include the RAG search_documentation tool (registered directly on McpServer, not in route registry)
  const ragName = 'search_documentation'
  let ragExposed: boolean
  if (cfg.enabledTools !== null) {
    ragExposed = cfg.enabledTools.includes(ragName)
  } else {
    ragExposed = !cfg.disabledTools.includes(ragName)
  }
  tools.push({
    name: ragName,
    description: 'Search the platform documentation knowledge base using semantic similarity.',
    exposed: ragExposed,
    readOnly: false,
  })

  // Include the unified read_resource tool (replaces individual GET route tools)
  const readResourceName = 'read_resource'
  let readResourceExposed: boolean
  if (!cfg.exposeResourcesAsTools) {
    // When exposeResourcesAsTools is off, read_resource is always disabled
    readResourceExposed = false
  } else if (cfg.enabledTools !== null) {
    readResourceExposed = cfg.enabledTools.includes(readResourceName)
  } else {
    readResourceExposed = !cfg.disabledTools.includes(readResourceName)
  }
  tools.push({
    name: readResourceName,
    description: 'Unified read tool — reads data from any available GET endpoint by path.',
    exposed: readResourceExposed,
    readOnly: true,
  })

  return tools
}

function buildResourceList(cfg: McpEndpointConfig) {
  if (!isResourceRegistryInitialized()) return []

  const registry = getResourceRegistry()
  return Array.from(registry.entries()).map(([name, meta]) => {
    let exposed: boolean
    if (cfg.enabledTools !== null) {
      exposed = cfg.enabledTools.includes(name)
    } else {
      exposed = !cfg.disabledTools.includes(name)
    }
    return { name, description: describeResource(name, meta), uri: proxySmartResourceUri(meta.path), exposed }
  })
}
