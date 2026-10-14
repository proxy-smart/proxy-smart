// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import { adminAuditLogger } from '@/lib/admin-audit-logger'
import { AdminAuditEventsResponse, AdminAuditAnalyticsResponse } from '@/schemas/admin-audit'
import { createEventLoggerMonitoringRoutes } from './factory'

/**
 * Admin audit monitoring routes — real-time SSE streams + REST queries.
 */
export const adminAuditMonitoring = createEventLoggerMonitoringRoutes({
  prefix: '/monitoring/admin-audit',
  tag: 'admin-audit-monitoring',
  logger: adminAuditLogger,
  connectionMessage: 'Connected to admin audit stream',
  eventsResponseSchema: AdminAuditEventsResponse,
  analyticsResponseSchema: AdminAuditAnalyticsResponse,
  emptyAnalytics: {
    totalActions: 0,
    successRate: 0,
    actionsByType: {},
    actionsByResource: {},
    topActors: [],
    hourlyStats: [],
    recentFailures: [],
  },
  getEvents: (query) => adminAuditLogger.getRecentEvents({
    limit: query.limit ? parseInt(query.limit) : 100,
    action: query.action !== 'all' ? query.action : undefined,
    resource: query.resource !== 'all' ? query.resource : undefined,
    actor: query.actor || undefined,
    success: query.success !== undefined ? query.success === 'true' : undefined,
    since: query.since ? new Date(query.since) : undefined,
  }),
  extraQueryParams: {
    action: t.Optional(t.String()),
    resource: t.Optional(t.String()),
    actor: t.Optional(t.String()),
  },
  eventsStreamSummary: 'Admin Audit Events Stream',
  eventsStreamDescription: 'SSE stream of real-time admin audit events (mutations only)',
  analyticsStreamSummary: 'Admin Audit Analytics Stream',
  eventsGetSummary: 'Get Admin Audit Events',
  eventsGetDescription: 'Retrieve recent admin audit events with optional filtering by action, resource, actor, and success',
  analyticsGetSummary: 'Get Admin Audit Analytics',
  analyticsGetDescription: 'Get current admin audit analytics (last 24 hours)',
})
