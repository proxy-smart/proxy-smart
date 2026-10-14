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
import { createMonitoringRoutes } from './factory'
import { createJsonlExportSpec } from './exports'

/**
 * OAuth monitoring routes — real-time monitoring, analytics, health and exports.
 */

const RESPONSE_TIME_ALERT_MS = 500
const STORAGE_ALERT_PERCENT = 70

const EMPTY_ANALYTICS: OAuthAnalyticsResponseType = {
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
  timestamp: new Date().toISOString(),
  predictiveInsights: undefined,
  weekdayInsights: undefined,
}

/** Analytics are stored per flow; the REST shape reports them per request. */
function toAnalyticsResponse(): OAuthAnalyticsResponseType {
  const analytics = oauthMetricsLogger.getAnalytics()
  if (!analytics) return { ...EMPTY_ANALYTICS, timestamp: new Date().toISOString() }

  const totalRequests = analytics.totalFlows || 0
  const successfulRequests = Math.round(totalRequests * ((analytics.successRate || 0) / 100))

  return {
    totalRequests,
    successfulRequests,
    failedRequests: totalRequests - successfulRequests,
    successRate: analytics.successRate || 0,
    averageResponseTime: analytics.averageResponseTime || 0,
    activeTokens: analytics.activeTokens || 0,
    topClients: analytics.topClients || [],
    flowsByType: analytics.flowsByType || {},
    errorsByType: analytics.errorsByType || {},
    hourlyStats: analytics.hourlyStats || [],
    timestamp: new Date().toISOString(),
    predictiveInsights: analytics.predictiveInsights ?? undefined,
    weekdayInsights: analytics.weekdayInsights ?? undefined,
  }
}

function buildHealth() {
  const analytics = oauthMetricsLogger.getAnalytics()
  const storagePercent = Math.round(
    (oauthMetricsLogger.getEventCount() / oauthMetricsLogger.getEventCapacity()) * 100,
  )
  const alerts: Array<{ type: string; message: string }> = []

  if (analytics && analytics.averageResponseTime > RESPONSE_TIME_ALERT_MS) {
    alerts.push({
      type: 'warning',
      message: `High response time detected on authorization endpoint (avg ${analytics.averageResponseTime.toFixed(0)}ms)`,
    })
  }

  if (storagePercent >= STORAGE_ALERT_PERCENT) {
    alerts.push({
      type: 'info',
      message: `Token storage is at ${storagePercent}% capacity. Consider cleanup or expansion.`,
    })
  }

  return {
    oauthServer: {
      status: 'healthy',
      uptime: process.uptime(),
      responseTime: analytics?.averageResponseTime || 0,
    },
    tokenStore: {
      status: 'healthy',
      activeTokens: analytics?.activeTokens || 0,
      storageUsed: storagePercent,
    },
    network: {
      status: 'healthy',
      throughput: oauthMetricsLogger.getThroughputPerMinute(),
      errorRate: analytics ? (100 - analytics.successRate) : 0,
    },
    alerts,
    timestamp: new Date().toISOString(),
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
    {
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
    },
    {
      path: '/analytics',
      handler: () => toAnalyticsResponse(),
      response: OAuthAnalyticsResponse,
      summary: 'Get OAuth Analytics',
      description: 'Get current OAuth analytics and metrics',
    },
    {
      path: '/health',
      handler: () => buildHealth(),
      response: MonitoringHealthResponse,
      summary: 'Get System Health',
      description: 'Get OAuth system health metrics and alerts',
    },
    {
      path: '/analytics/export',
      handler: ({ set }) => {
        const analytics = oauthMetricsLogger.getAnalytics()
        if (!analytics) {
          set.status = 404
          throw new Error('No analytics data available')
        }
        set.headers['Content-Type'] = 'application/json'
        set.headers['Content-Disposition'] = `attachment; filename="oauth-analytics-${new Date().toISOString().split('T')[0]}.json"`
        return { format: 'json', data: analytics }
      },
      response: ExportResponse,
      summary: 'Export Analytics Data',
      description: 'Download current OAuth analytics data as JSON file',
    },
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
