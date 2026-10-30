// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Per-server FHIR MCP tools (/fhir/{server_id}/mcp), opt-in via `mcpEnabled`.
 * Every call runs through executeFhirRequest as the bearer, bound to this server or its MCP endpoint.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { config } from '../../config'
import { getAllServers, getServerInfoByName } from '../fhir-server-store'
import { validateToken } from '../auth'
import { createFhirTarget, executeFhirRequest } from '../fhir-request-pipeline'
import { fhirMcpUrl } from '../mcp-resources'

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
    tokenPayload = await validateToken(authToken, { enforceAudience: false })
  } catch {
    return { status: 401, data: { error: 'Authentication failed' } }
  }

  const authHeader = `Bearer ${authToken}`
  const headers = new Headers({ authorization: authHeader, accept: 'application/fhir+json' })
  const requestBody = body === undefined ? undefined : JSON.stringify(body)
  if (requestBody !== undefined) headers.set('content-type', 'application/fhir+json')

  const target = await createFhirTarget(serverInfo, serverName, fhirVersion)
  const result = await executeFhirRequest(target, { tokenPayload, authHeader, endpoint: fhirMcpUrl(serverName) }, {
    method,
    resourcePath: resourceId ? `${resourceType}/${resourceId}` : resourceType,
    queryString: queryParams ? `?${queryParams}` : '',
    headers,
    body: requestBody,
  })
  return { status: result.status, data: result.body }
}

type FhirToolRequest = Omit<FhirProxyOptions, 'authToken' | 'serverName'>

async function runFhirTool(tokenRef: { current?: string }, serverName: string, request: FhirToolRequest) {
  if (!tokenRef.current) {
    return { content: [{ type: 'text' as const, text: 'Authentication required' }], isError: true }
  }
  const result = await proxyFhirRequest({ ...request, serverName, authToken: tokenRef.current })
  const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
  return { content: [{ type: 'text' as const, text }], ...(result.status >= 400 && { isError: true }) }
}

/** Register FHIR tools scoped to one server; the server name is fixed per endpoint. */
export function registerFhirToolsForServer(server: McpServer, tokenRef: { current?: string }, serverName: string): void {
  const fhirVersion = z.string().optional().describe('FHIR version (e.g. "R4"). Defaults to the server\'s primary version.')
  const run = (request: FhirToolRequest) => runFhirTool(tokenRef, serverName, request)

  server.registerTool(
    'fhir_read',
    {
      description:
        'Read a single FHIR resource by type and ID (e.g. Patient/123). Returns the full JSON resource.',
      inputSchema: z.object({
        resourceType: z.string().describe('FHIR resource type (e.g. "Patient", "Observation", "MedicationRequest")'),
        id: z.string().describe('Logical ID of the resource'),
        fhirVersion,
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (args) => run({ method: 'GET', resourceType: args.resourceType, resourceId: args.id, fhirVersion: args.fhirVersion }),
  )

  server.registerTool(
    'fhir_search',
    {
      description:
        'Search FHIR resources using standard FHIR search parameters. Returns a Bundle of matching resources.',
      inputSchema: z.object({
        resourceType: z.string().describe('FHIR resource type to search (e.g. "Patient", "Observation")'),
        queryParams: z.string().optional().describe('FHIR search parameters as a query string (e.g. "name=John&birthdate=gt1990-01-01")'),
        fhirVersion,
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (args) => run({ method: 'GET', resourceType: args.resourceType, queryParams: args.queryParams, fhirVersion: args.fhirVersion }),
  )

  server.registerTool(
    'fhir_create',
    {
      description: 'Create a new FHIR resource. Provide the full resource JSON including resourceType.',
      inputSchema: z.object({
        resourceType: z.string().describe('FHIR resource type (e.g. "Patient", "Observation")'),
        resource: z.record(z.string(), z.unknown()).describe('The full FHIR resource JSON to create'),
        fhirVersion,
      }),
    },
    (args) => run({ method: 'POST', resourceType: args.resourceType, body: args.resource, fhirVersion: args.fhirVersion }),
  )

  server.registerTool(
    'fhir_update',
    {
      description: 'Update an existing FHIR resource by type and ID (PUT semantics).',
      inputSchema: z.object({
        resourceType: z.string().describe('FHIR resource type (e.g. "Patient", "Observation")'),
        id: z.string().describe('Logical ID of the resource to update'),
        resource: z.record(z.string(), z.unknown()).describe('The full FHIR resource JSON (must include id)'),
        fhirVersion,
      }),
    },
    (args) => run({ method: 'PUT', resourceType: args.resourceType, resourceId: args.id, body: args.resource, fhirVersion: args.fhirVersion }),
  )

  server.registerTool(
    'fhir_delete',
    {
      description: 'Delete a FHIR resource by type and ID.',
      inputSchema: z.object({
        resourceType: z.string().describe('FHIR resource type (e.g. "Patient", "Observation")'),
        id: z.string().describe('Logical ID of the resource to delete'),
        fhirVersion,
      }),
    },
    (args) => run({ method: 'DELETE', resourceType: args.resourceType, resourceId: args.id, fhirVersion: args.fhirVersion }),
  )

  server.registerTool(
    'fhir_capabilities',
    {
      description: 'Get the CapabilityStatement (metadata) of this FHIR server.',
      inputSchema: z.object({ fhirVersion }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (args) => run({ method: 'GET', resourceType: 'metadata', fhirVersion: args.fhirVersion }),
  )
}
