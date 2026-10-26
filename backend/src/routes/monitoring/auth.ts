// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import { authEventsLogger } from '@/lib/auth-events-logger'
import { AuthEventsResponse, AuthAnalyticsResponse } from '@/schemas/auth-monitoring'
import { createEventLoggerMonitoringRoutes } from './factory'

/**
 * Auth event monitoring routes — real-time SSE streams + REST queries.
 * Polls Keycloak for LOGIN, LOGOUT, REGISTER, CODE_TO_TOKEN, etc.
 */
export const authMonitoring = createEventLoggerMonitoringRoutes({
  prefix: '/monitoring/auth',
  tag: 'auth-monitoring',
  logger: authEventsLogger,
  connectionMessage: 'Connected to auth events stream',
  eventsResponseSchema: AuthEventsResponse,
  analyticsResponseSchema: AuthAnalyticsResponse,
  emptyAnalytics: {
    totalEvents: 0,
    successRate: 100,
    eventsByType: {},
    recentErrors: [],
    hourlyStats: [],
    topClients: [],
    timestamp: new Date().toISOString(),
  },
  getEvents: (query) => authEventsLogger.getRecentEvents({
    limit: query.limit ? parseInt(query.limit) : 100,
    type: query.type !== 'all' ? query.type : undefined,
    success: query.success !== undefined ? query.success === 'true' : undefined,
    since: query.since ? new Date(query.since) : undefined,
    clientId: query.clientId,
    userId: query.userId,
    includeServiceAccounts: query.includeServiceAccounts === 'true',
  }),
  extraQueryParams: {
    clientId: t.Optional(t.String()),
    userId: t.Optional(t.String()),
    includeServiceAccounts: t.Optional(t.String({
      description: '"true" to include service-account logins (CLIENT_LOGIN), which are left out by default. Filtering by type=CLIENT_LOGIN or by clientId includes them anyway.',
    })),
  },
  eventsStreamSummary: 'Auth Events Stream',
  eventsStreamDescription: 'SSE stream of real-time authentication events (logins, logouts, registrations, token exchanges)',
  analyticsStreamSummary: 'Auth Analytics Stream',
  eventsGetSummary: 'Get Auth Events',
  eventsGetDescription: 'Retrieve recent auth events with optional filtering by type, success, date, client, and user',
  analyticsGetSummary: 'Get Auth Analytics',
  analyticsGetDescription: 'Get current auth event analytics (last 24 hours)',
})
