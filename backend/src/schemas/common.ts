// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

/**
 * Common schemas shared across all API routes
 */

// ==================== Standard Responses ====================

export const ErrorResponse = t.Object({
  error: t.String({ description: 'Error message' }),
  code: t.Optional(t.String({ description: 'Error code' })),
  details: t.Optional(t.Any())
}, { title: 'ErrorResponse' })

export const SuccessResponse = t.Object({
  success: t.Boolean({ description: 'Whether the operation was successful' }),
  message: t.Optional(t.String({ description: 'Success message' }))
}, { title: 'SuccessResponse' })

// Common response schemas for different HTTP status codes
export const CommonErrorResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  500: ErrorResponse
}

// TypeScript type inference helpers
export type ErrorResponseType = Static<typeof ErrorResponse>
export type SuccessResponseType = Static<typeof SuccessResponse>

// ==================== Count Responses ====================

export const CountResponse = t.Object({
  count: t.Number({ description: 'Number of enabled items' }),
  total: t.Number({ description: 'Total number of items' })
}, { title: 'CountResponse' })

export type CountResponseType = Static<typeof CountResponse>

// ==================== Server Operation Responses ====================

export const ServerOperationResponse = t.Object({
  success: t.Boolean({ description: 'Whether the operation was successful' }),
  message: t.String({ description: 'Operation message' }),
  timestamp: t.String({ description: 'Timestamp (ISO 8601)' })
}, { title: 'ServerOperationResponse' })

export type ServerOperationResponseType = Static<typeof ServerOperationResponse>

// ==================== Pagination ====================

export const PaginationQuery = t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 50, description: 'Number of items per page' })),
  offset: t.Optional(t.Numeric({ minimum: 0, default: 0, description: 'Number of items to skip' }))
})

// TypeScript type inference helpers
export type PaginationQueryType = Static<typeof PaginationQuery>

// ==================== Health & Status Responses ====================

export const HealthResponse = t.Object({
  status: t.String({ description: 'Health status (healthy, degraded, unhealthy)' }),
  timestamp: t.String({ description: 'Timestamp (ISO 8601)' }),
  uptime: t.Number({ description: 'Server uptime in milliseconds' })
}, { title: 'HealthResponse' })

export type HealthResponseType = Static<typeof HealthResponse>

export const HealthErrorResponse = t.Object({
  status: t.String({ description: 'Health status' }),
  timestamp: t.String({ description: 'Timestamp (ISO 8601)' }),
  error: t.String({ description: 'Error message' })
}, { title: 'HealthErrorResponse' })

export type HealthErrorResponseType = Static<typeof HealthErrorResponse>

export const FhirServerInfo = t.Object({
  name: t.String({ description: 'FHIR server name' }),
  url: t.String({ description: 'FHIR server URL' }),
  status: t.String({ description: 'Server status (healthy, unhealthy)' }),
  accessible: t.Boolean({ description: 'Whether server is accessible' }),
  version: t.String({ description: 'FHIR version' }),
  serverName: t.Optional(t.String({ description: 'Server-reported name' })),
  serverVersion: t.Optional(t.String({ description: 'Server-reported version' })),
  error: t.Optional(t.String({ description: 'Error details if unhealthy' }))
}, { title: 'FhirServerHealthInfo' })

export type FhirServerInfoType = Static<typeof FhirServerInfo>

export const SystemStatusResponse = t.Object({
  version: t.String({ description: 'API version' }),
  timestamp: t.String({ description: 'Timestamp (ISO 8601)' }),
  uptime: t.Number({ description: 'Server uptime in milliseconds' }),
  overall: t.String({ description: 'Overall system status' }),
  fhir: t.Object({
    status: t.String({ description: 'FHIR infrastructure status' }),
    totalServers: t.Number({ description: 'Total FHIR servers configured' }),
    healthyServers: t.Number({ description: 'Number of healthy FHIR servers' }),
    servers: t.Array(FhirServerInfo, { description: 'FHIR server status details' })
  }),
  keycloak: t.Object({
    status: t.String({ description: 'Keycloak status' }),
    accessible: t.Boolean({ description: 'Whether Keycloak is accessible' }),
    realm: t.String({ description: 'Keycloak realm' }),
    lastConnected: t.Optional(t.String({ description: 'Last successful connection timestamp' }))
  }),
  memory: t.Object({
    used: t.Number({ description: 'Memory used in bytes' }),
    total: t.Number({ description: 'Total memory in bytes' })
  })
}, { title: 'SystemStatusResponse' })

export type SystemStatusResponseType = Static<typeof SystemStatusResponse>

/** What anyone may know: whether the deployment is up, and which version. Upstream URLs and versions stay admin-only. */
export const PublicStatusResponse = t.Pick(SystemStatusResponse, ['version', 'timestamp', 'overall'], { title: 'PublicStatusResponse' })

export type PublicStatusResponseType = Static<typeof PublicStatusResponse>

