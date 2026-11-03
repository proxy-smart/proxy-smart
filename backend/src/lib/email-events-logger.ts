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
import { matchesSchema } from './type-guards'
import { EmailEvent as EmailEventSchema, type EmailAnalyticsResponseType, type EmailEventType } from '@/schemas/email-monitoring'

// ─── Types ───────────────────────────────────────────────────────

export type EmailEvent = EmailEventType
export type EmailAnalytics = EmailAnalyticsResponseType

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
      isEvent: matchesSchema(EmailEventSchema),
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
