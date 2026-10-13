// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * FHIR MCP Tools
 *
 * Registers FHIR tools (fhir_read, fhir_search, fhir_create, fhir_update, fhir_delete, fhir_capabilities)
 * scoped to a specific FHIR server for per-server MCP endpoints (/fhir/{server_id}/mcp).
 * These are opt-in per server via the `mcpEnabled` flag in the admin UI.
 *
 * Design:
 * - Tools use the authenticated MCP session's Bearer token
 * - Server name is hardcoded per endpoint — not user-selectable
 * - FHIR version defaults to the first supported version (usually R4)
 * - Every call runs through the FHIR proxy pipeline (executeFhirRequest), so the same access control applies
 */
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { config } from '../../config'
import { getAllServers, getServerInfoByName } from '../fhir-server-store'
import { validateToken } from '../auth'
import { createFhirTarget, executeFhirRequest } from '../fhir-request-pipeline'

// ── Internal proxy helper ────────────────────────────────────────────────────

interface FhirProxyOptions {
  method: string
  serverName?: string
  fhirVersion?: string
  resourceType: string
  resourceId?: string
  queryParams?: string
  body?: unknown
  authToken: string
}

async function proxyFhirRequest(opts: FhirProxyOptions): Promise<{ status: number; data: unknown }> {
  const { method, resourceType, resourceId, queryParams, body, authToken } = opts
  const fhirVersion = opts.fhirVersion || config.fhir.supportedVersions[0] || 'R4'

  let serverName = opts.serverName
  if (!serverName) {
    const servers = await getAllServers()
    if (servers.length === 0) {
      return { status: 503, data: { error: 'No FHIR servers configured' } }
    }
    serverName = servers[0].identifier
  }

  if (!config.fhir.supportedVersions.includes(fhirVersion)) {
    return { status: 400, data: { error: `Unsupported FHIR version: ${fhirVersion}` } }
  }

  const serverInfo = await getServerInfoByName(serverName)
  if (!serverInfo) {
    return { status: 404, data: { error: `FHIR server '${serverName}' not found` } }
  }

  let tokenPayload: Record<string, unknown>
  try {
    tokenPayload = await validateToken(authToken)
  } catch {
    return { status: 401, data: { error: 'Authentication failed' } }
  }

  const authHeader = `Bearer ${authToken}`
  const headers = new Headers({ authorization: authHeader, accept: 'application/fhir+json' })
  const requestBody = body === undefined ? undefined : JSON.stringify(body)
  if (requestBody !== undefined) headers.set('content-type', 'application/fhir+json')

  const target = await createFhirTarget(serverInfo, serverName, fhirVersion)
  const result = await executeFhirRequest(target, { tokenPayload, authHeader }, {
    method,
    resourcePath: resourceId ? `${resourceType}/${resourceId}` : resourceType,
    queryString: queryParams ? `?${queryParams}` : '',
    headers,
    body: requestBody,
  })
  return { status: result.status, data: result.body }
}

// ── Tool registration ────────────────────────────────────────────────────────

/**
 * Register FHIR tools scoped to a specific server.
 * Used by per-server MCP endpoints (/fhir/{server_id}/mcp).
 * The serverName is hardcoded — tools don't accept a serverName parameter.
 */
export function registerFhirToolsForServer(server: McpServer, tokenRef: { current?: string }, serverName: string): void {
  const fhirVersionDescription = 'FHIR version (e.g. "R4"). Defaults to the server\'s primary version.'

  // fhir_read
  server.registerTool(
    'fhir_read',
    {
      description:
        'Read a single FHIR resource by type and ID (e.g. Patient/123). Returns the full JSON resource.',
      inputSchema: z.object({
              resourceType: z.string().describe('FHIR resource type (e.g. "Patient", "Observation", "MedicationRequest")'),
              id: z.string().describe('Logical ID of the resource'),
              fhirVersion: z.string().optional().describe(fhirVersionDescription),
            }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ resourceType, id, fhirVersion }) => {
      if (!tokenRef.current) {
        return { content: [{ type: 'text' as const, text: 'Authentication required' }], isError: true }
      }
      const result = await proxyFhirRequest({
        method: 'GET',
        resourceType: resourceType as string,
        resourceId: id as string,
        serverName,
        fhirVersion: fhirVersion as string | undefined,
        authToken: tokenRef.current,
      })
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
      return { content: [{ type: 'text' as const, text }], ...(result.status >= 400 && { isError: true }) }
    },
  )

  // fhir_search
  server.registerTool(
    'fhir_search',
    {
      description:
        'Search FHIR resources using standard FHIR search parameters. Returns a Bundle of matching resources.',
      inputSchema: z.object({
              resourceType: z.string().describe('FHIR resource type to search (e.g. "Patient", "Observation")'),
              queryParams: z.string().optional().describe('FHIR search parameters as a query string (e.g. "name=John&birthdate=gt1990-01-01")'),
              fhirVersion: z.string().optional().describe(fhirVersionDescription),
            }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ resourceType, queryParams, fhirVersion }) => {
      if (!tokenRef.current) {
        return { content: [{ type: 'text' as const, text: 'Authentication required' }], isError: true }
      }
      const result = await proxyFhirRequest({
        method: 'GET',
        resourceType: resourceType as string,
        queryParams: queryParams as string | undefined,
        serverName,
        fhirVersion: fhirVersion as string | undefined,
        authToken: tokenRef.current,
      })
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
      return { content: [{ type: 'text' as const, text }], ...(result.status >= 400 && { isError: true }) }
    },
  )

  // fhir_create
  server.registerTool(
    'fhir_create',
    {
      description: 'Create a new FHIR resource. Provide the full resource JSON including resourceType.',
      inputSchema: z.object({
              resourceType: z.string().describe('FHIR resource type (e.g. "Patient", "Observation")'),
              resource: z.record(z.string(), z.unknown()).describe('The full FHIR resource JSON to create'),
              fhirVersion: z.string().optional().describe(fhirVersionDescription),
            }),
    },
    async ({ resourceType, resource, fhirVersion }) => {
      if (!tokenRef.current) {
        return { content: [{ type: 'text' as const, text: 'Authentication required' }], isError: true }
      }
      const result = await proxyFhirRequest({
        method: 'POST',
        resourceType: resourceType as string,
        body: resource,
        serverName,
        fhirVersion: fhirVersion as string | undefined,
        authToken: tokenRef.current,
      })
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
      return { content: [{ type: 'text' as const, text }], ...(result.status >= 400 && { isError: true }) }
    },
  )

  // fhir_update
  server.registerTool(
    'fhir_update',
    {
      description: 'Update an existing FHIR resource by type and ID (PUT semantics).',
      inputSchema: z.object({
              resourceType: z.string().describe('FHIR resource type (e.g. "Patient", "Observation")'),
              id: z.string().describe('Logical ID of the resource to update'),
              resource: z.record(z.string(), z.unknown()).describe('The full FHIR resource JSON (must include id)'),
              fhirVersion: z.string().optional().describe(fhirVersionDescription),
            }),
    },
    async ({ resourceType, id, resource, fhirVersion }) => {
      if (!tokenRef.current) {
        return { content: [{ type: 'text' as const, text: 'Authentication required' }], isError: true }
      }
      const result = await proxyFhirRequest({
        method: 'PUT',
        resourceType: resourceType as string,
        resourceId: id as string,
        body: resource,
        serverName,
        fhirVersion: fhirVersion as string | undefined,
        authToken: tokenRef.current,
      })
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
      return { content: [{ type: 'text' as const, text }], ...(result.status >= 400 && { isError: true }) }
    },
  )

  // fhir_delete
  server.registerTool(
    'fhir_delete',
    {
      description: 'Delete a FHIR resource by type and ID.',
      inputSchema: z.object({
              resourceType: z.string().describe('FHIR resource type (e.g. "Patient", "Observation")'),
              id: z.string().describe('Logical ID of the resource to delete'),
              fhirVersion: z.string().optional().describe(fhirVersionDescription),
            }),
    },
    async ({ resourceType, id, fhirVersion }) => {
      if (!tokenRef.current) {
        return { content: [{ type: 'text' as const, text: 'Authentication required' }], isError: true }
      }
      const result = await proxyFhirRequest({
        method: 'DELETE',
        resourceType: resourceType as string,
        resourceId: id as string,
        serverName,
        fhirVersion: fhirVersion as string | undefined,
        authToken: tokenRef.current,
      })
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
      return { content: [{ type: 'text' as const, text }], ...(result.status >= 400 && { isError: true }) }
    },
  )

  // fhir_capabilities
  server.registerTool(
    'fhir_capabilities',
    {
      description: 'Get the CapabilityStatement (metadata) of this FHIR server.',
      inputSchema: z.object({
              fhirVersion: z.string().optional().describe(fhirVersionDescription),
            }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ fhirVersion }) => {
      if (!tokenRef.current) {
        return { content: [{ type: 'text' as const, text: 'Authentication required' }], isError: true }
      }
      const result = await proxyFhirRequest({
        method: 'GET',
        resourceType: 'metadata',
        serverName,
        fhirVersion: fhirVersion as string | undefined,
        authToken: tokenRef.current,
      })
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
      return { content: [{ type: 'text' as const, text }], ...(result.status >= 400 && { isError: true }) }
    },
  )
}
