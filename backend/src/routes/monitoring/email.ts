// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { emailEventsLogger } from '@/lib/email-events-logger'
import { EmailEventsResponse, EmailAnalyticsResponse } from '@/schemas/email-monitoring'
import { createEventLoggerMonitoringRoutes } from './factory'

/**
 * Email monitoring routes — real-time SSE streams + REST queries.
 * Polls Keycloak for SEND_RESET_PASSWORD, SEND_VERIFY_EMAIL, etc.
 */
export const emailMonitoring = createEventLoggerMonitoringRoutes({
  prefix: '/monitoring/email',
  tag: 'email-monitoring',
  logger: emailEventsLogger,
  connectionMessage: 'Connected to email events stream',
  eventsResponseSchema: EmailEventsResponse,
  analyticsResponseSchema: EmailAnalyticsResponse,
  emptyAnalytics: {
    totalEvents: 0,
    successRate: 100,
    eventsByType: {},
    recentErrors: [],
    hourlyStats: [],
    timestamp: new Date().toISOString(),
  },
  getEvents: (query) => emailEventsLogger.getRecentEvents({
    limit: query.limit ? parseInt(query.limit) : 100,
    type: query.type !== 'all' ? query.type : undefined,
    success: query.success !== undefined ? query.success === 'true' : undefined,
    since: query.since ? new Date(query.since) : undefined,
  }),
  eventsStreamSummary: 'Email Events Stream',
  eventsStreamDescription: 'SSE stream of real-time email events (password resets, email verifications, etc.)',
  analyticsStreamSummary: 'Email Analytics Stream',
  eventsGetSummary: 'Get Email Events',
  eventsGetDescription: 'Retrieve recent email events with optional filtering by type, success, and date',
  analyticsGetSummary: 'Get Email Analytics',
  analyticsGetDescription: 'Get current email event analytics (last 24 hours)',
})
