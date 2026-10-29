// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { config } from '@/config'
import { getAllServers, getServerInfoByName, ensureServersInitialized, retryUnknownServers } from '@/lib/fhir-server-store'
import { logger } from '@/lib/logger'
import { handleAdminError } from '@/lib/admin-error-handler'
import { proxyOAuthEndpoints } from '@/lib/oidc-discovery'
import { fhirServerView, proxyServerEndpoints, serverCoreFields } from './server-view'
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

/** Public, unauthenticated discovery of the FHIR servers this proxy fronts; changes live in fhirServersAdminRoutes. */
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

      const servers = serverInfos.map(fhirServerView)

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

      const oauth = proxyOAuthEndpoints(config.baseUrl)

      return {
        ...serverCoreFields(serverInfo),
        endpoints: {
          ...proxyServerEndpoints(serverInfo),
          authorize: oauth.authorization_endpoint,
          token: oauth.token_endpoint,
          registration: oauth.registration_endpoint,
          introspection: oauth.introspection_endpoint,
          revocation: oauth.revocation_endpoint,
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
