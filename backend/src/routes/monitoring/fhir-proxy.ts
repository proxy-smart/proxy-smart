// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import { fhirProxyMetricsLogger } from '@/lib/fhir-proxy-metrics-logger'
import {
  FhirProxyEventsResponse,
  FhirProxyAnalyticsResponse,
} from '@/schemas/monitoring'
import { createMonitoringRoutes } from './factory'

/**
 * FHIR proxy request monitoring routes — SSE streams + REST history + analytics.
 *
 * Uses the general factory rather than the event-logger shorthand because its
 * analytics are returned nested under `analytics` rather than spread.
 */
export const fhirProxyMonitoring = createMonitoringRoutes({
  prefix: '/monitoring/fhir-proxy',
  tag: 'fhir-proxy-monitoring',
  streams: [
    {
      path: '/events/stream',
      connectionMessage: 'Connected to FHIR proxy metrics stream',
      subscribe: (emit) => fhirProxyMetricsLogger.subscribe(emit),
      summary: 'FHIR Proxy Event Stream',
      description: 'SSE stream of real-time FHIR proxy request events',
    },
    {
      path: '/analytics/stream',
      initial: () => fhirProxyMetricsLogger.getAnalytics(),
      subscribe: (emit) => fhirProxyMetricsLogger.subscribeAnalytics(emit),
      summary: 'FHIR Proxy Analytics Stream',
      description: 'SSE stream of real-time FHIR proxy analytics, updated on every request',
    },
  ],
  endpoints: [
    {
      path: '/events',
      handler: ({ query }) => {
        const events = fhirProxyMetricsLogger.getRecentEvents({
          serverName: query.serverName || undefined,
          statusCode: query.statusCode ? parseInt(query.statusCode) : undefined,
          limit: query.limit ? parseInt(query.limit) : 200,
          since: query.since ? new Date(query.since) : undefined,
        })
        return { events, total: events.length, timestamp: new Date().toISOString() }
      },
      query: {
        serverName: t.Optional(t.String({ description: 'Filter by server name' })),
        statusCode: t.Optional(t.String({ description: 'Filter by HTTP status code' })),
        limit: t.Optional(t.String({ description: 'Max events to return' })),
        since: t.Optional(t.String({ description: 'Return events since this ISO timestamp' })),
      },
      response: FhirProxyEventsResponse,
      summary: 'Get FHIR Proxy Events',
      description: 'Retrieve recent FHIR proxy request events with optional filtering',
    },
    {
      path: '/analytics',
      handler: () => ({ analytics: fhirProxyMetricsLogger.getAnalytics(), timestamp: new Date().toISOString() }),
      response: FhirProxyAnalyticsResponse,
      summary: 'Get FHIR Proxy Analytics',
      description: 'Snapshot of FHIR proxy request analytics for the last 24 hours',
    },
  ],
})
