// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * OAuth WebSocket Monitoring
 *
 * Real-time WebSocket endpoint for OAuth flow monitoring.
 * Uses the shared createMonitoringWebSocket factory.
 */

import { oauthMetricsLogger, type OAuthFlowEvent } from '../lib/oauth-metrics-logger'
import type { OAuthAnalytics } from '../lib/oauth-metrics-logger'
import { logger } from '../lib/logger'
import {
  createEventFilter,
  createMonitoringWebSocket,
  executeBaseControlAction,
} from './websocket-factory'
import type { MonitoringLogger } from '../lib/events/journal'
import type { WebSocketClient } from '../schemas/websocket'
import type { ControlMessageType } from '../schemas/websocket'

const applyEventFilters = createEventFilter<OAuthFlowEvent>(
  event => event.type,
  event => event.timestamp,
)

async function executeControlAction(
  control: ControlMessageType,
  metricsLogger: MonitoringLogger<OAuthFlowEvent, OAuthAnalytics>,
): Promise<Record<string, unknown>> {
  switch (control.action) {
    case 'set_log_level': {
      const level = (control.parameters as Record<string, unknown>)?.level
      if (level) {
        logger.ws.info('Log level changed via WebSocket control', { newLevel: level })
        return { level, changed: true }
      }
      throw new Error('Log level parameter required')
    }

    case 'set_retention': {
      const retentionDays = (control.parameters as Record<string, unknown>)?.retentionDays
      if (retentionDays) {
        return { retentionDays, updated: true }
      }
      throw new Error('Retention days parameter required')
    }

    default:
      return executeBaseControlAction(control, metricsLogger, {
        clearLogsMessage: 'Log clear requested via WebSocket control',
      })
  }
}

function setupLogSubscription(client: WebSocketClient) {
  client.ws.send(JSON.stringify({
    type: 'logs_data',
    data: {
      message: 'Log subscription active',
      level: client.filters.logLevel || 'info',
    },
  }))
}

const { plugin, broadcast } = createMonitoringWebSocket<OAuthFlowEvent, OAuthAnalytics>({
  prefix: '/oauth/monitoring',
  channel: 'OAuth',
  tag: 'oauth-monitoring',
  metricsLogger: oauthMetricsLogger,
  subscriptionTypes: ['events', 'analytics', 'logs'],
  applyEventFilters,
  executeControlAction,
  setupLogSubscription,
})

export const oauthWebSocket = plugin
export const broadcastToOAuthClients = broadcast
