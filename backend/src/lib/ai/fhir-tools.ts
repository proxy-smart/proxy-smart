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
 */
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { config } from '../../config'
import { getAllServers, getServerInfoByName } from '../fhir-server-store'
import { validateToken } from '../auth'
import { checkConsentWithIal, getConsentConfig } from '../consent'
import { enforceScopeAccess, enforceRoleBasedFiltering, type AccessControlContext } from '../smart-access-control'
import { enforceTenantIsolation } from '../tenant-isolation'
import { getServerCapabilities, normalizeSearchParams, parseFhirPath, isInteractionSupported } from '../fhir-capabilities'
import { fetchWithMtls, getMtlsConfig } from '../mtls'
import { fhirProxyMetricsLogger } from '../fhir-proxy-metrics-logger'
import { tokenActorChain } from '../token-context-store'
import fetch from 'cross-fetch'

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

  // Resolve server
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

  const serverUrl = serverInfo.url

  // Validate token
  let tokenPayload: Record<string, unknown>
  try {
    tokenPayload = await validateToken(authToken) as Record<string, unknown>
  } catch {
    return { status: 401, data: { error: 'Authentication failed' } }
  }

  // Build resource path
  let resourcePath = resourceType
  if (resourceId) resourcePath += `/${resourceId}`

  // Consent enforcement
  const consentResult = await checkConsentWithIal(
    tokenPayload,
    serverName,
    serverUrl,
    resourcePath,
    method,
    `Bearer ${authToken}`,
  )
  if (consentResult.decision === 'deny' && getConsentConfig().mode === 'enforce') {
    const consentAppUrl = getConsentConfig().appUrl
    return {
      status: 403,
      data: {
        error: 'consent_denied',
        message: consentResult.reason,
        ...(consentAppUrl && {
          consentRequestUrl: consentAppUrl,
          hint: 'The patient has not granted consent for this access. You may request consent via the consent management app.',
        }),
      },
    }
  }

  // mTLS config
  const mtlsConfig = await getMtlsConfig(serverInfo.identifier)
  const serverFetch = async (url: string, init?: RequestInit) => {
    const useMtls = mtlsConfig?.enabled === true && url.startsWith('https://')
    return useMtls
      ? fetchWithMtls(url, { ...init, serverId: serverInfo.identifier })
      : fetch(url, init)
  }

  // Build query string
  let qs = queryParams ? `?${queryParams}` : ''

  // Tenant isolation — verify org access and inject query filters
  const tenantResult = enforceTenantIsolation(
    serverInfo, tokenPayload, resourcePath, method, qs,
  )
  if (!tenantResult.allowed) {
    return { status: tenantResult.status ?? 403, data: tenantResult.body }
  }
  qs = tenantResult.modifiedQueryString ?? qs

  // SMART scope enforcement + role-based filtering
  const acCtx: AccessControlContext = {
    tokenPayload,
    resourcePath,
    method,
    serverUrl,
    serverId: serverInfo.identifier,
    serverName,
    authHeader: `Bearer ${authToken}`,
    upstreamFetch: serverFetch,
  }
  const scopeResult = enforceScopeAccess(acCtx)
  if (!scopeResult.allowed) {
    return { status: scopeResult.status ?? 403, data: scopeResult.body }
  }
  const roleResult = await enforceRoleBasedFiltering(acCtx, qs)
  if (!roleResult.allowed) {
    return { status: roleResult.status ?? 403, data: roleResult.body }
  }
  qs = roleResult.modifiedQueryString ?? qs

  // Capability-aware normalization
  const fhirCtx = parseFhirPath(resourcePath, method)
  const capabilities = await getServerCapabilities(serverUrl, serverInfo.identifier)

  if (capabilities && fhirCtx.resourceType) {
    const strictMode = serverInfo.strictCapabilities === true
    if (strictMode && !fhirCtx.isOperation && !fhirCtx.isHistory) {
      if (!isInteractionSupported(capabilities, fhirCtx.resourceType, method, fhirCtx.hasSearchSemantics)) {
        return {
          status: 405,
          data: {
            resourceType: 'OperationOutcome',
            issue: [{ severity: 'error', code: 'not-supported', diagnostics: `${method} on ${fhirCtx.resourceType} is not supported` }],
          },
        }
      }
    }
    if (qs.length > 1 && fhirCtx.resourceType) {
      const normResult = normalizeSearchParams(capabilities, fhirCtx.resourceType, qs)
      const normalized = normResult.normalizedParams.toString()
      qs = normalized ? `?${normalized}` : ''
    }
  }

  // Execute upstream request
  const target = `${serverUrl}/${resourcePath}${qs}`
  const headers = new Headers()
  headers.set('authorization', `Bearer ${authToken}`)
  headers.set('accept', 'application/fhir+json')
  if (body) headers.set('content-type', 'application/fhir+json')

  const fetchStart = performance.now()
  const resp = (mtlsConfig?.enabled && target.startsWith('https://'))
    ? await fetchWithMtls(target, { method, headers, body: body ? JSON.stringify(body) : undefined, serverId: serverInfo.identifier })
    : await fetch(target, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const fetchMs = Math.round(performance.now() - fetchStart)

  // Track metrics
  fhirProxyMetricsLogger.logRequest({
    serverName,
    method,
    resourcePath,
    resourceType,
    statusCode: resp.status,
    responseTimeMs: fetchMs,
    clientId: (tokenPayload.azp || tokenPayload.client_id) as string | undefined,
    actorChain: tokenActorChain(tokenPayload),
    userId: tokenPayload.sub as string | undefined,
    username: tokenPayload.preferred_username as string | undefined,
    error: resp.status >= 400 ? `HTTP ${resp.status}` : undefined,
  })

  // Parse response
  const text = await resp.text()
  const proxyBase = `${config.baseUrl}/${config.name}/${serverName}/${fhirVersion}`
  const replaced = text.replaceAll(serverUrl, proxyBase)
  try {
    return { status: resp.status, data: JSON.parse(replaced) }
  } catch {
    return { status: resp.status, data: replaced }
  }
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
