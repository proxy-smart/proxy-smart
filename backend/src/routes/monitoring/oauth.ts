// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import { oauthMetricsLogger } from '@/lib/oauth-metrics-logger'
import { logger } from '@/lib/logger'
import {
  MonitoringHealthResponse,
  ExportResponse,
  OAuthEventsResponse,
  OAuthAnalyticsResponse,
  type OAuthAnalyticsResponseType,
} from '@/schemas/monitoring'
import { createMonitoringRoutes, monitoringEndpoint } from './factory'
import { createJsonlExportSpec } from './exports'

/**
 * OAuth monitoring routes — real-time monitoring, analytics, health and exports.
 */

const EMPTY_ANALYTICS: Omit<OAuthAnalyticsResponseType, 'timestamp'> = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  successRate: 0,
  averageResponseTime: 0,
  activeTokens: 0,
  topClients: [],
  flowsByType: {},
  errorsByType: {},
  hourlyStats: [],
}

/** Analytics are stored per flow; the REST shape reports them per request. */
function toAnalyticsResponse(): OAuthAnalyticsResponseType {
  const analytics = oauthMetricsLogger.getAnalytics()
  const timestamp = new Date().toISOString()
  if (!analytics) return { ...EMPTY_ANALYTICS, timestamp }
  return {
    totalRequests: analytics.totalFlows,
    successfulRequests: analytics.successfulFlows,
    failedRequests: analytics.totalFlows - analytics.successfulFlows,
    successRate: analytics.successRate,
    averageResponseTime: analytics.averageResponseTime,
    activeTokens: analytics.activeTokens,
    topClients: analytics.topClients,
    flowsByType: analytics.flowsByType,
    errorsByType: analytics.errorsByType,
    hourlyStats: analytics.hourlyStats,
    timestamp,
    predictiveInsights: analytics.predictiveInsights,
    weekdayInsights: analytics.weekdayInsights,
  }
}

export const oauthMonitoring = createMonitoringRoutes({
  prefix: '/monitoring/oauth',
  tag: 'oauth-monitoring',
  streams: [
    {
      path: '/events/stream',
      connectionMessage: 'Connected to OAuth events stream',
      subscribe: (emit) => oauthMetricsLogger.subscribe(emit),
      summary: 'OAuth Events Stream',
      description: 'SSE stream of real-time OAuth events',
    },
    {
      path: '/analytics/stream',
      initial: () => oauthMetricsLogger.getAnalytics(),
      subscribe: (emit) => oauthMetricsLogger.subscribeAnalytics(emit),
      summary: 'OAuth Analytics Stream',
      description: 'SSE stream of real-time OAuth analytics updates',
    },
  ],
  endpoints: [
    monitoringEndpoint({
      path: '/events',
      handler: ({ query }) => {
        const events = oauthMetricsLogger.getRecentEvents({
          limit: query.limit ? parseInt(query.limit) : 100,
          type: query.type !== 'all' ? query.type : undefined,
          status: query.status !== 'all' ? query.status : undefined,
          clientId: query.clientId,
          since: query.since ? new Date(query.since) : undefined,
        })
        return { events, total: events.length, timestamp: new Date().toISOString() }
      },
      query: {
        limit: t.Optional(t.String({ description: 'Maximum number of events to return' })),
        type: t.Optional(t.String({ description: 'Filter by event type' })),
        status: t.Optional(t.String({ description: 'Filter by event status' })),
        clientId: t.Optional(t.String({ description: 'Filter by client ID' })),
        since: t.Optional(t.String({ description: 'Filter events since this timestamp' })),
      },
      response: OAuthEventsResponse,
      summary: 'Get OAuth Events',
      description: 'Retrieve recent OAuth events with optional filtering',
    }),
    monitoringEndpoint({
      path: '/analytics',
      handler: () => toAnalyticsResponse(),
      response: OAuthAnalyticsResponse,
      summary: 'Get OAuth Analytics',
      description: 'Get current OAuth analytics and metrics',
    }),
    monitoringEndpoint({
      path: '/health',
      handler: () => oauthMetricsLogger.healthSnapshot(),
      response: MonitoringHealthResponse,
      summary: 'Get System Health',
      description: 'Get OAuth system health metrics and alerts',
    }),
    monitoringEndpoint({
      path: '/analytics/export',
      handler: ({ set }) => {
        set.headers['Content-Type'] = 'application/json'
        set.headers['Content-Disposition'] = `attachment; filename="oauth-analytics-${new Date().toISOString().split('T')[0]}.json"`
        return { format: 'json' as const, data: toAnalyticsResponse() }
      },
      response: ExportResponse,
      summary: 'Export Analytics Data',
      description: 'Download current OAuth analytics data as JSON file',
    }),
    createJsonlExportSpec({
      logDir: 'oauth-metrics',
      logFile: 'oauth-events.jsonl',
      downloadPrefix: 'oauth-events',
      summary: 'Export Events Data',
      description: 'Download OAuth events log as JSONL file',
      onError: (error) => logger.auth.error('Failed to export OAuth events', { error }),
    }),
  ],
})
