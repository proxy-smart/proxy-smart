// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { getServerInfoByName, ensureServersInitialized } from '@/lib/fhir-server-store'
import { logger } from '@/lib/logger'
import { handleAdminError } from '@/lib/admin-error-handler'
import { fhirServerDetailsView, fhirServerListView } from './server-view'
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
      return await fhirServerListView()
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

      return fhirServerDetailsView(serverInfo)
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
