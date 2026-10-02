// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { getRuntimeDicomServers, getDicomServerById, pickDefaultDicomServer } from '@/lib/runtime-config'
import { dicomwebProxyBase, probePacs } from '@/lib/dicom-pacs'
import { logger } from '@/lib/logger'
import { handleAdminError } from '@/lib/admin-error-handler'
import {
  ErrorResponse,
  CommonErrorResponses,
  DicomServerIdParam,
  DicomServerDiscoveryResponse,
  DicomServerReachabilityResponse,
  type DicomServerDiscoveryResponseType,
  type DicomServerReachabilityResponseType,
  type ErrorResponseType,
} from '@/schemas'

/** Public, read-only DICOM server discovery; upstream URLs and credentials stay admin-only */
export const dicomServerDiscoveryRoutes = new Elysia({ prefix: '/dicom-servers', tags: ['dicom-servers'] })
  .get('/', ({ set }): DicomServerDiscoveryResponseType | ErrorResponseType => {
    try {
      const configured = getRuntimeDicomServers()
      const defaultId = pickDefaultDicomServer(configured)?.id
      const servers = configured.map(server => ({
        id: server.id,
        name: server.name,
        isDefault: server.id === defaultId,
        dicomweb: dicomwebProxyBase(server.id),
      }))
      return { totalServers: servers.length, servers }
    } catch (error) {
      logger.fhir.error('Failed to list DICOM servers', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: DicomServerDiscoveryResponse,
      500: ErrorResponse,
    },
    detail: {
      summary: 'List Available DICOM Servers',
      description: 'List the DICOM servers this proxy fronts, with the proxied DICOMweb base to use for each. Upstream PACS addresses and credentials are never included.',
      tags: ['servers'],
    },
  })
  .get('/:server_id/status', async ({ params, set }): Promise<DicomServerReachabilityResponseType | ErrorResponseType> => {
    try {
      const server = getDicomServerById(params.server_id)
      if (!server) {
        set.status = 404
        return { error: `DICOM server '${params.server_id}' not found` }
      }
      const { reachable, message } = await probePacs(server)
      return { id: server.id, reachable, message }
    } catch (error) {
      logger.fhir.error('Failed to probe DICOM server', { serverId: params.server_id, error })
      return handleAdminError(error, set)
    }
  }, {
    params: DicomServerIdParam,
    response: {
      200: DicomServerReachabilityResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'DICOM Server Reachability',
      description: 'Probe whether the proxy can reach a DICOM server. reachable is null when no probe could run.',
      tags: ['servers'],
    },
  })
