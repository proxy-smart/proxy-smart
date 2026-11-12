// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// One read_resource tool stands in for every GET route, instead of 80+ get_* tools.
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { executeResourceResult } from '@maxhealth.tech/elysia-mcp'
import { prefabView, uiToolMeta } from '@maxhealth.tech/elysia-mcp/prefab'
import {
  getResourceRegistry,
  isResourceRegistryInitialized,
  requireDispatchApp,
  type ResourceMetadata,
} from './tool-registry'
import { isResourceExposed } from '../mcp-endpoint-config'
import { config } from '../../config'

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

function matchResource(
  requestPath: string,
  resources: Map<string, ResourceMetadata>,
): { meta: ResourceMetadata; pathParams: Record<string, string> } | null {
  const exact = resources.get(requestPath)
  if (exact) return { meta: exact, pathParams: {} }

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

export function registerReadResourceTool(
  server: McpServer,
  userRoles: string[],
  tokenRef: { current?: string },
): void {
  const resources = buildResourceIndex(userRoles)
  if (resources.size === 0) return

  // The view is chosen per call from the resource that answered, not from this tool's name.
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
        const params: Record<string, string> = {
          ...match.pathParams,
          ...query,
        }

        // Runs the full Elysia pipeline; 'auto' keeps JSON wherever TOON would be larger.
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
