// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Consent WebSocket Monitoring
 *
 * Real-time WebSocket endpoint for consent decision monitoring.
 * Uses the shared createMonitoringWebSocket factory.
 */

import { consentMetricsLogger, type ConsentDecisionEvent } from '../lib/consent-metrics-logger'
import type { ConsentAnalytics } from '../lib/consent-metrics-logger'
import {
  createControlActionHandler,
  createEventFilter,
  createMonitoringWebSocket,
} from './websocket-factory'

const applyEventFilters = createEventFilter<ConsentDecisionEvent>(
  event => event.decision,
  event => event.timestamp,
)

const executeControlAction = createControlActionHandler<ConsentDecisionEvent, ConsentAnalytics>({
  clearLogsMessage: 'Consent log clear requested via WebSocket control',
})

const { plugin, broadcast } = createMonitoringWebSocket<ConsentDecisionEvent, ConsentAnalytics>({
  prefix: '/consent/monitoring',
  channel: 'Consent',
  tag: 'consent-monitoring',
  metricsLogger: consentMetricsLogger,
  subscriptionTypes: ['events', 'analytics'],
  applyEventFilters,
  executeControlAction,
})

export const consentWebSocket = plugin
export const broadcastToConsentClients = broadcast
