// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { config } from '@/config'
import { getAllServers, getServerInfoByName, ensureServersInitialized, retryUnknownServers } from '@/lib/fhir-server-store'
import { logger } from '@/lib/logger'
import { handleAdminError } from '@/lib/admin-error-handler'
import {
  ErrorResponse,
  FhirServerInfoResponse,
  CommonErrorResponses,
  ServerIdParam,
  type FhirServerInfoResponseType,
  type FhirServerListResponseType,
  type ErrorResponseType,
  FhirServerListResponse,
} from '@/schemas'

/**
 * Public server discovery — which FHIR servers this proxy fronts.
 *
 * Read-only and unauthenticated on purpose: a client must be able to find the servers before
 * it holds a token for any of them, and CI's compliance job reads this to learn what to test.
 * Everything that CHANGES a server lives in `fhirServersAdminRoutes`.
 */
export const serverDiscoveryRoutes = new Elysia({ prefix: '/fhir-servers', tags: ['fhir-servers'] })
  // List all available FHIR servers
  .get('/', async ({ set }): Promise<FhirServerListResponseType | ErrorResponseType> => {
    try {
      // Ensure servers are initialized
      await ensureServersInitialized()

      // Auto-retry metadata for servers that previously failed (non-blocking)
      await retryUnknownServers()

      // Get all servers from the store
      const serverInfos = await getAllServers()

      const servers = serverInfos.map(serverInfo => ({
        id: serverInfo.identifier,
        name: serverInfo.name, // Use the actual name, not identifier
        url: serverInfo.url,
        fhirVersion: serverInfo.metadata.fhirVersion,
        serverVersion: serverInfo.metadata.serverVersion,
        serverName: serverInfo.metadata.serverName,
        supported: serverInfo.metadata.supported,
        smartCapabilities: serverInfo.metadata.smartCapabilities,
        strictCapabilities: serverInfo.strictCapabilities ?? false,
        mcpEnabled: serverInfo.mcpEnabled ?? false,
        organizationIds: serverInfo.organizationIds,
        endpoints: {
          base: `${config.baseUrl}/${config.name}/${serverInfo.identifier}/${serverInfo.metadata.fhirVersion}`,
          smartConfig: `${config.baseUrl}/${config.name}/${serverInfo.identifier}/${serverInfo.metadata.fhirVersion}/.well-known/smart-configuration`,
          metadata: `${config.baseUrl}/${config.name}/${serverInfo.identifier}/${serverInfo.metadata.fhirVersion}/metadata`
        }
      }))

      return {
        totalServers: servers.length,
        servers
      }
    } catch (error) {
      logger.fhir.error('Failed to list FHIR servers', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: FhirServerListResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'List Available FHIR Servers',
      description: 'Get a list of all configured FHIR servers with their connection information and endpoints',
      tags: ['servers']
    }
  })
  // Get specific server information
  .get('/:server_id', async ({ params, set }): Promise<FhirServerInfoResponseType | ErrorResponseType> => {
    try {
      // Ensure servers are initialized
      await ensureServersInitialized()

      // Get server info from store
      const serverInfo = await getServerInfoByName(params.server_id)

      if (!serverInfo) {
        set.status = 404
        return { error: `FHIR server '${params.server_id}' not found` }
      }

      // Build proxy endpoints for this FHIR server
      // These are the SMART on FHIR endpoints that the PROXY provides
      const proxyBase = `${config.baseUrl}/${config.name}/${serverInfo.identifier}/${serverInfo.metadata.fhirVersion}`

      return {
        name: serverInfo.name,
        url: serverInfo.url,
        fhirVersion: serverInfo.metadata.fhirVersion,
        serverVersion: serverInfo.metadata.serverVersion,
        serverName: serverInfo.metadata.serverName,
        supported: serverInfo.metadata.supported,
        smartCapabilities: serverInfo.metadata.smartCapabilities,
        strictCapabilities: serverInfo.strictCapabilities ?? false,
        mcpEnabled: serverInfo.mcpEnabled ?? false,
        endpoints: {
          // Proxy's FHIR endpoints
          base: proxyBase,
          smartConfig: `${proxyBase}/.well-known/smart-configuration`,
          metadata: `${proxyBase}/metadata`,

          // Proxy's OAuth endpoints (provided by Keycloak via the proxy)
          authorize: `${config.baseUrl}/auth/authorize`,
          token: `${config.baseUrl}/auth/token`,
          registration: `${config.baseUrl}/auth/register`,
          manage: `${config.baseUrl}/auth/manage`,
          introspection: `${config.baseUrl}/auth/introspect`,
          revocation: `${config.baseUrl}/auth/revoke`
        }
      }
    } catch (error) {
      logger.fhir.error('Failed to get server information', { serverId: params.server_id, error })
      return handleAdminError(error, set)
    }
  }, {
    params: ServerIdParam,
    response: {
      200: FhirServerInfoResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Server Information',
      description: 'Get detailed information about a specific FHIR server',
      tags: ['servers']
    }
  })
