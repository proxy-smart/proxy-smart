// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { getFhirServer, listFhirServers } from './server-view'
import { ErrorResponse, FhirServerInfoResponse, CommonErrorResponses, ServerIdParam, FhirServerListResponse } from '@/schemas'

/** Public, unauthenticated discovery of the FHIR servers this proxy fronts; changes live in fhirServersAdminRoutes. */
export const serverDiscoveryRoutes = new Elysia({ prefix: '/fhir-servers', tags: ['fhir-servers'] })
  .get('/', listFhirServers, {
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
  .get('/:server_id', getFhirServer, {
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
