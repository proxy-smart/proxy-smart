// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import { consentMetricsLogger } from '@/lib/consent-metrics-logger'
import { accessLogFilters, accessLogQueryFields } from '@/lib/consent/access-log'
import { logger } from '@/lib/logger'
import { createMonitoringRoutes } from './factory'
import { createJsonlExportSpec } from './exports'

/**
 * Consent monitoring routes — real-time event stream + REST queries + analytics,
 * plus a patient-scoped access log for "who read my record, and when".
 */

const EMPTY_ANALYTICS = {
  totalDecisions: 0,
  permitRate: 0,
  denyRate: 0,
  averageCheckDuration: 0,
  cacheHitRate: 0,
  decisionsByMode: {},
  decisionsByResourceType: {},
  topDeniedClients: [],
  topDeniedPatients: [],
  hourlyStats: [],
}

export const consentMonitoring = createMonitoringRoutes({
  prefix: '/monitoring/consent',
  tag: 'consent-monitoring',
  streams: [
    {
      path: '/events/stream',
      connectionMessage: 'Connected to consent events stream',
      subscribe: (emit) => consentMetricsLogger.subscribe(emit),
      summary: 'Consent Events Stream',
      description: 'SSE stream of real-time consent decision events',
    },
    {
      path: '/analytics/stream',
      initial: () => consentMetricsLogger.getAnalytics(),
      subscribe: (emit) => consentMetricsLogger.subscribeAnalytics(emit),
      summary: 'Consent Analytics Stream',
      description: 'SSE stream of real-time consent decision analytics',
    },
  ],
  endpoints: [
    {
      path: '/events',
      handler: ({ query }) => {
        const events = consentMetricsLogger.getRecentEvents({
          limit: query.limit ? parseInt(query.limit) : 100,
          decision: query.decision !== 'all' ? query.decision : undefined,
          clientId: query.clientId || undefined,
          patientId: query.patientId || undefined,
          resourceType: query.resourceType !== 'all' ? query.resourceType : undefined,
          since: query.since ? new Date(query.since) : undefined,
        })
        return { events, total: events.length, timestamp: new Date().toISOString() }
      },
      query: {
        limit: t.Optional(t.String()),
        decision: t.Optional(t.String()),
        clientId: t.Optional(t.String()),
        patientId: t.Optional(t.String()),
        resourceType: t.Optional(t.String()),
        since: t.Optional(t.String()),
      },
      summary: 'Get Consent Events',
      description: 'Retrieve recent consent decision events with optional filtering',
    },
    {
      path: '/analytics',
      handler: () => {
        const analytics = consentMetricsLogger.getAnalytics()
        return { ...(analytics ?? EMPTY_ANALYTICS), timestamp: new Date().toISOString() }
      },
      summary: 'Get Consent Analytics',
      description: 'Get current consent decision analytics (last 24 hours)',
    },
    createJsonlExportSpec({
      logDir: 'consent-metrics',
      logFile: 'consent-events.jsonl',
      downloadPrefix: 'consent-events',
      summary: 'Export Consent Events',
      description: 'Download consent events log as JSONL file',
      onError: (error) => logger.consent.error('Failed to export consent events', { error }),
    }),
    {
      path: '/patients/:patientId/access-log',
      handler: ({ params, query }) => {
        const events = consentMetricsLogger.patientAccessLog(params.patientId, accessLogFilters(query))
        return { events, total: events.length, patientId: params.patientId, timestamp: new Date().toISOString() }
      },
      params: { patientId: t.String() },
      query: accessLogQueryFields,
      summary: 'Patient Access Log',
      description: 'Retrieve data access events for a specific patient (who accessed what, when)',
    },
  ],
})
