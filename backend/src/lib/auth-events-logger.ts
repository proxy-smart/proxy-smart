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

/** A client-credentials token: backend services polling, not a person signing in. */
export const SERVICE_ACCOUNT_LOGIN = 'CLIENT_LOGIN'

/** Auth events add the Keycloak session id to the shared mapping. */
export function mapAuthEvent(kc: KeycloakEvent): AuthEvent {
  return { ...mapBaseKeycloakEvent(kc, 'auth'), sessionId: kc.sessionId }
}

// ─── Implementation ──────────────────────────────────────────────

export class AuthEventsLogger extends BaseEventsLogger<AuthEvent, AuthAnalytics> {
  constructor(logSubdir = 'auth-events') {
    super({
      logSubdir,
      logFilename: 'auth-events.jsonl',
      eventTypes: AUTH_EVENT_TYPES,
      channel: logger.auth,
      idPrefix: 'auth',
      mapEvent: mapAuthEvent,
    })
  }

  /** Service-account logins are left out unless asked for, by flag, by their type or by client. */
  getRecentEvents(opts?: {
    limit?: number
    type?: string
    success?: boolean
    since?: Date
    clientId?: string
    userId?: string
    includeServiceAccounts?: boolean
  }): AuthEvent[] {
    const showServiceAccounts = opts?.includeServiceAccounts === true
      || opts?.type === SERVICE_ACCOUNT_LOGIN
      || Boolean(opts?.clientId)
    return this.selectEvents(
      opts,
      event => !opts?.type || opts.type === 'all' || event.type === opts.type,
      event => opts?.success === undefined || event.success === opts.success,
      event => !opts?.clientId || event.clientId === opts.clientId,
      event => !opts?.userId || event.userId === opts.userId,
      event => showServiceAccounts || event.type !== SERVICE_ACCOUNT_LOGIN,
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
