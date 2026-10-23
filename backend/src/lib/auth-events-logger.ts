// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Auth Events Logger
 *
 * Polls Keycloak for authentication-related events (LOGIN, LOGOUT, REGISTER,
 * CODE_TO_TOKEN, etc.) using the shared BaseEventsLogger infrastructure.
 */

import { BaseEventsLogger, mapBaseKeycloakEvent, type KeycloakEvent } from './base-events-logger'
import { tallyBy, topEntries } from './events/aggregate'
import { logger } from './logger'
import { AUTH_EVENT_TYPES } from './keycloak-event-types'

// ─── Types ───────────────────────────────────────────────────────

export interface AuthEvent {
  id: string
  timestamp: string
  type: string
  userId?: string
  clientId?: string
  sessionId?: string
  ipAddress?: string
  error?: string
  success: boolean
  details?: Record<string, string>
}

export interface AuthAnalytics {
  totalEvents: number
  successRate: number
  eventsByType: Record<string, number>
  recentErrors: AuthEvent[]
  hourlyStats: Array<{ hour: string; success: number; failure: number; total: number }>
  topClients: Array<{ clientId: string; count: number }>
  timestamp: string
}

export { AUTH_EVENT_TYPES }

/** Auth events add the Keycloak session id to the shared mapping. */
export function mapAuthEvent(kc: KeycloakEvent): AuthEvent {
  return { ...mapBaseKeycloakEvent(kc, 'auth'), sessionId: kc.sessionId }
}

// ─── Implementation ──────────────────────────────────────────────

class AuthEventsLogger extends BaseEventsLogger<AuthEvent, AuthAnalytics> {
  constructor() {
    super({
      logSubdir: 'auth-events',
      logFilename: 'auth-events.jsonl',
      eventTypes: AUTH_EVENT_TYPES,
      channel: logger.auth,
      idPrefix: 'auth',
      mapEvent: mapAuthEvent,
    })
  }

  /** Additional filter options specific to auth events */
  getRecentEvents(opts?: {
    limit?: number
    type?: string
    success?: boolean
    since?: Date
    clientId?: string
    userId?: string
  }): AuthEvent[] {
    return this.selectEvents(
      opts,
      event => !opts?.type || opts.type === 'all' || event.type === opts.type,
      event => opts?.success === undefined || event.success === opts.success,
      event => !opts?.clientId || event.clientId === opts.clientId,
      event => !opts?.userId || event.userId === opts.userId,
    )
  }

  protected computeAnalytics(recent: AuthEvent[]): AuthAnalytics {
    return {
      ...this.computeBaseAnalytics(recent),
      recentErrors: recent.filter(event => !event.success).slice(0, 20),
      topClients: topEntries(tallyBy(recent, event => event.clientId))
        .map(([clientId, count]) => ({ clientId, count })),
    }
  }
}

// ─── Singleton export ───────────────────────────────────────────

export const authEventsLogger = new AuthEventsLogger()
