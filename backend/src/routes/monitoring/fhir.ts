// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import { fhirHealthLogger } from '@/lib/fhir-health-logger'
import {
  FhirHealthChecksResponse,
  FhirUptimeSummariesResponse,
} from '@/schemas/monitoring'
import { createMonitoringRoutes } from './factory'

/**
 * FHIR server health monitoring routes — SSE + REST history + uptime summaries.
 *
 * Streams per-check results and per-sweep uptime summaries rather than the
 * conventional events/analytics pair, so it builds on the general factory.
 */
export const fhirMonitoring = createMonitoringRoutes({
  prefix: '/monitoring/fhir',
  tag: 'fhir-monitoring',
  streams: [
    {
      path: '/checks/stream',
      connectionMessage: 'Connected to FHIR health stream',
      subscribe: (emit) => fhirHealthLogger.subscribeToChecks(emit),
      summary: 'FHIR Health Check Stream',
      description: 'SSE stream of real-time FHIR server health check results',
    },
    {
      path: '/summaries/stream',
      initial: () => fhirHealthLogger.getSummaries(),
      subscribe: (emit) => fhirHealthLogger.subscribeToSummaries(emit),
      summary: 'FHIR Uptime Summary Stream',
      description: 'SSE stream of FHIR server uptime summaries, emitted after each check sweep',
    },
  ],
  endpoints: [
    {
      path: '/checks',
      handler: ({ query }) => {
        const checks = fhirHealthLogger.getRecentChecks({
          serverUrl: query.serverUrl || undefined,
          limit: query.limit ? parseInt(query.limit) : 200,
          since: query.since ? new Date(query.since) : undefined,
        })
        return { checks, total: checks.length, timestamp: new Date().toISOString() }
      },
      query: {
        serverUrl: t.Optional(t.String({ description: 'Filter by server URL' })),
        limit: t.Optional(t.String({ description: 'Max checks to return' })),
        since: t.Optional(t.String({ description: 'Return checks since this ISO timestamp' })),
      },
      response: FhirHealthChecksResponse,
      summary: 'Get FHIR Health Checks',
      description: 'Retrieve recent FHIR server health check results with optional filtering',
    },
    {
      path: '/summaries',
      handler: () => ({ servers: fhirHealthLogger.getSummaries(), timestamp: new Date().toISOString() }),
      response: FhirUptimeSummariesResponse,
      summary: 'Get FHIR Uptime Summaries',
      description: 'Per-server uptime percentage, average response time, and recent check history',
    },
  ],
})
