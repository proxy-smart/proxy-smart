// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Email Events Logger
 *
 * Polls Keycloak for email-related events (SEND_RESET_PASSWORD, SEND_VERIFY_EMAIL,
 * EXECUTE_ACTIONS, etc.) using the shared BaseEventsLogger infrastructure.
 */

import { BaseEventsLogger, mapBaseKeycloakEvent, type KeycloakEvent } from './base-events-logger'
import { logger } from './logger'
import { EMAIL_EVENT_TYPES } from './keycloak-event-types'

// ─── Types ───────────────────────────────────────────────────────

export interface EmailEvent {
  id: string
  timestamp: string
  type: string
  userId?: string
  clientId?: string
  ipAddress?: string
  error?: string
  success: boolean
  details?: Record<string, string>
}

export interface EmailAnalytics {
  totalEvents: number
  successRate: number
  eventsByType: Record<string, number>
  recentErrors: EmailEvent[]
  hourlyStats: Array<{ hour: string; success: number; failure: number; total: number }>
  timestamp: string
}

export { EMAIL_EVENT_TYPES }

/** Email events use the shared mapping unchanged. */
export function mapEmailEvent(kc: KeycloakEvent): EmailEvent {
  return mapBaseKeycloakEvent(kc, 'email')
}

// ─── Implementation ──────────────────────────────────────────────

class EmailEventsLogger extends BaseEventsLogger<EmailEvent, EmailAnalytics> {
  constructor() {
    super({
      logSubdir: 'email-events',
      logFilename: 'email-events.jsonl',
      eventTypes: EMAIL_EVENT_TYPES,
      channel: logger.email,
      idPrefix: 'email',
      mapEvent: mapEmailEvent,
    })
  }

  protected computeAnalytics(recent: EmailEvent[]): EmailAnalytics {
    return {
      ...this.computeBaseAnalytics(recent),
      recentErrors: recent.filter(event => !event.success).slice(0, 20),
    }
  }
}

// ─── Singleton export ───────────────────────────────────────────

export const emailEventsLogger = new EmailEventsLogger()
