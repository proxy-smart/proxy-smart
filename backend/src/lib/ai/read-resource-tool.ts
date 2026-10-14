// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Unified read_resource MCP tool.
 *
 * Collapses all individual GET route tools into a single `read_resource` tool
 * that accepts a path and optional query parameters, dispatching to the
 * matching GET route handler.
 *
 * MCP clients (LLMs) see one tool with a description listing all available
 * resource paths, rather than 80+ individual get_* tools.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { executeResourceResult } from '@maxhealth.tech/elysia-mcp'
import { prefabView, uiToolMeta } from '@maxhealth.tech/elysia-mcp/prefab'
import {
  getResourceRegistry,
  isResourceRegistryInitialized,
  requireDispatchApp,
} from './tool-registry'
import type { ResourceMetadata } from './tool-registry'
import { isResourceExposed } from '../mcp-endpoint-config'
import { config } from '../../config'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a lookup map of available GET resources, keyed by their API path.
 * Filters by permission (public vs admin-only) and resource-exposure config.
 */
function buildResourceIndex(userRoles: string[]): Map<string, ResourceMetadata> {
  if (!isResourceRegistryInitialized()) return new Map()

  const registry = getResourceRegistry()
  const index = new Map<string, ResourceMetadata>()

  for (const [resourceName, meta] of registry) {
    if (!isResourceExposed(resourceName)) continue
    if (!meta.public && !userRoles.includes('admin')) continue
    index.set(meta.path, meta)
  }

  return index
}

/**
 * Generate the description for the unified read_resource tool.
 * Includes a list of available resource paths so LLMs know what to call.
 */
function buildReadResourceDescription(resources: Map<string, ResourceMetadata>): string {
  const paths = [...resources.keys()].sort()
  const pathList = paths.map((p) => `  - ${p}`).join('\n')
  return [
    'Read data from any available GET endpoint. Pass the API path and optional query parameters.',
    'For parameterized paths, replace path segments with actual values (e.g. /admin/users/abc123).',
    '',
    'Available paths:',
    pathList,
  ].join('\n')
}

/**
 * Match a concrete path against the resource index, supporting path params.
 * e.g. "/admin/users/abc123" matches "/admin/users/:userId"
 */
function matchResource(
  requestPath: string,
  resources: Map<string, ResourceMetadata>,
): { meta: ResourceMetadata; pathParams: Record<string, string> } | null {
  // 1. Try exact match first (static routes)
  const exact = resources.get(requestPath)
  if (exact) return { meta: exact, pathParams: {} }

  // 2. Try parameterized routes
  const requestSegments = requestPath.split('/').filter(Boolean)

  for (const [pattern, meta] of resources) {
    const patternSegments = pattern.split('/').filter(Boolean)
    if (patternSegments.length !== requestSegments.length) continue

    const params: Record<string, string> = {}
    let matched = true

    for (let i = 0; i < patternSegments.length; i++) {
      if (patternSegments[i].startsWith(':')) {
        params[patternSegments[i].slice(1)] = requestSegments[i]
      } else if (patternSegments[i] !== requestSegments[i]) {
        matched = false
        break
      }
    }

    if (matched) return { meta, pathParams: params }
  }

  return null
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the unified `read_resource` MCP tool.
 * Takes a `path` and optional `query` params, dispatches to the matching GET handler.
 */
export function registerReadResourceTool(
  server: McpServer,
  userRoles: string[],
  tokenRef: { current?: string },
): void {
  const resources = buildResourceIndex(userRoles)
  if (resources.size === 0) return

  // This one tool stands in for every GET route, so it carries the admin lists
  // — the payloads a table is actually worth drawing. The view is chosen per
  // call from the resource that answered, not from this tool's own name.
  const view = config.mcp.ui ? prefabView() : undefined

  server.registerTool(
    'read_resource',
    {
      description: buildReadResourceDescription(resources),
      ...(view ? { _meta: uiToolMeta() } : {}),
      inputSchema: z.object({
              path: z.string().describe('The API path to read (e.g. /admin/users, /admin/smart-apps/:appId)'),
              query: z.record(z.string(), z.string()).optional().describe('Optional query parameters as key-value pairs'),
            }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ path, query }) => {
      const match = matchResource(path, resources)
      if (!match) {
        const available = [...resources.keys()].sort().join(', ')
        return {
          content: [{ type: 'text' as const, text: `Unknown path: ${path}. Available: ${available}` }],
          isError: true,
        }
      }

      try {
        // Runs the full Elysia pipeline (guards, response coercion, hooks); query params join the rebuilt request.
        const params: Record<string, string> = {
          ...match.pathParams,
          ...query,
        }

        // This tool collapses every GET route, so it carries the admin list
        // responses — the uniform, high-token payloads TOON's tabular form
        // actually collapses. 'auto' keeps JSON wherever TOON would be larger.
        const { text, structuredContent } = await executeResourceResult(
          match.meta,
          params,
          tokenRef.current,
          requireDispatchApp(),
          { textFormat: 'auto', ...(view ? { view } : {}) },
        )
        return structuredContent !== undefined
          ? { content: [{ type: 'text' as const, text }], structuredContent }
          : { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error reading ${path}: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        }
      }
    },
  )
}
