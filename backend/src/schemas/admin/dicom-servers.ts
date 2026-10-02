// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

/**
 * DICOM Server Management schemas
 */

export const DicomServerConfig = t.Object({
  id: t.String({ description: 'Unique server identifier (auto-generated slug)' }),
  name: t.String({ description: 'Display name for the DICOM server' }),
  baseUrl: t.String({ description: 'DICOMweb base URL (e.g. http://orthanc:8042/dicom-web)' }),
  wadoRoot: t.Optional(t.String({ description: 'WADO-RS root URL (defaults to baseUrl)' })),
  qidoRoot: t.Optional(t.String({ description: 'QIDO-RS root URL (defaults to baseUrl)' })),
  authType: t.Union([
    t.Literal('none'),
    t.Literal('basic'),
    t.Literal('bearer'),
    t.Literal('header'),
  ], { description: 'Authentication type for upstream PACS', default: 'none' }),
  authHeader: t.Optional(t.String({ description: 'Full Authorization header value (for header/bearer auth)' })),
  username: t.Optional(t.String({ description: 'Username (for basic auth)' })),
  password: t.Optional(t.String({ description: 'Password (for basic auth)' })),
  timeoutMs: t.Optional(t.Number({ description: 'Request timeout in milliseconds', default: 30000 })),
  isDefault: t.Optional(t.Boolean({ description: 'Whether this is the default DICOM server', default: false })),
}, { title: 'DicomServerConfig' })

export type DicomServerConfigType = Static<typeof DicomServerConfig>

export const AddDicomServerRequest = t.Object({
  name: t.String({ description: 'Display name', minLength: 1 }),
  baseUrl: t.String({ description: 'DICOMweb base URL', minLength: 1 }),
  wadoRoot: t.Optional(t.String({ description: 'WADO-RS root URL' })),
  qidoRoot: t.Optional(t.String({ description: 'QIDO-RS root URL' })),
  authType: t.Optional(t.Union([
    t.Literal('none'),
    t.Literal('basic'),
    t.Literal('bearer'),
    t.Literal('header'),
  ], { default: 'none' })),
  authHeader: t.Optional(t.String()),
  username: t.Optional(t.String()),
  password: t.Optional(t.String()),
  timeoutMs: t.Optional(t.Number({ default: 30000 })),
  isDefault: t.Optional(t.Boolean({ default: false })),
}, { title: 'AddDicomServerRequest' })

export type AddDicomServerRequestType = Static<typeof AddDicomServerRequest>

export const UpdateDicomServerRequest = t.Partial(AddDicomServerRequest, { title: 'UpdateDicomServerRequest' })

export type UpdateDicomServerRequestType = Static<typeof UpdateDicomServerRequest>

export const DicomServerIdParam = t.Object({
  server_id: t.String({ description: 'DICOM server ID' }),
})

export const DicomServerListResponse = t.Object({
  totalServers: t.Number({ description: 'Total number of configured DICOM servers' }),
  servers: t.Array(DicomServerConfig),
}, { title: 'DicomServerListResponse' })

const PacsReachable = t.Union([t.Boolean(), t.Null()], {
  description: 'Whether the PACS answered the probe; null when no probe could run',
})

export const PacsStatusResponse = t.Object({
  configured: t.Boolean(),
  reachable: PacsReachable,
  message: t.String(),
}, { title: 'PacsStatusResponse' })

export type PacsStatusType = Static<typeof PacsStatusResponse>

export const DicomServerStatusResponse = t.Object({
  id: t.String(),
  name: t.String(),
  configured: t.Boolean(),
  reachable: PacsReachable,
  message: t.String(),
}, { title: 'DicomServerStatusResponse' })

/**
 * Public discovery view of a DICOM server. Deliberately excludes the upstream
 * PACS URL and every credential field of DicomServerConfig.
 */
export const DicomServerSummary = t.Object({
  id: t.String({ description: 'DICOM server identifier' }),
  name: t.String({ description: 'Display name' }),
  isDefault: t.Boolean({ description: 'Whether unscoped /dicomweb requests are routed to this server' }),
  dicomweb: t.String({ description: 'Proxied DICOMweb base URL for this server (QIDO-RS, WADO-RS, STOW-RS)' }),
}, { title: 'DicomServerSummary' })

export type DicomServerSummaryType = Static<typeof DicomServerSummary>

export const DicomServerDiscoveryResponse = t.Object({
  totalServers: t.Number({ description: 'Total number of configured DICOM servers' }),
  servers: t.Array(DicomServerSummary),
}, { title: 'DicomServerDiscoveryResponse' })

export type DicomServerDiscoveryResponseType = Static<typeof DicomServerDiscoveryResponse>

export const DicomServerReachabilityResponse = t.Object({
  id: t.String({ description: 'DICOM server identifier' }),
  reachable: PacsReachable,
  message: t.String(),
}, { title: 'DicomServerReachabilityResponse' })

export type DicomServerReachabilityResponseType = Static<typeof DicomServerReachabilityResponse>
