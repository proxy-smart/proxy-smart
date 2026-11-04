// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Admin Audit Logger
 *
 * Persists every admin-route mutation (create / update / delete / action) over
 * the shared EventJournal, so the admin dashboard can show a real-time feed and
 * aggregated analytics via SSE / WebSocket.
 */

import { logger } from './logger'
import { EventJournal } from './events/journal'
import { bucketByHour, countBy, percent, tallyBy, topEntries } from './events/aggregate'
import { matchesSchema } from './type-guards'
import { AdminAuditEvent as AdminAuditEventSchema, type AdminAuditAnalyticsResponseType, type AdminAuditEventType } from '@/schemas/admin-audit'

export type AdminAuditEvent = AdminAuditEventType
export type AdminAuditAnalytics = Omit<AdminAuditAnalyticsResponseType, 'timestamp'>

const LOAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const actorName = (event: AdminAuditEvent): string => event.actor.username ?? event.actor.sub

class AdminAuditLogger extends EventJournal<AdminAuditEvent, AdminAuditAnalytics> {
  constructor() {
    super({
      logSubdir: 'admin-audit',
      logFilename: 'admin-audit.jsonl',
      idPrefix: 'audit',
      channel: logger.admin,
      isEvent: matchesSchema(AdminAuditEventSchema),
      loadWindowMs: LOAD_WINDOW_MS,
    })
  }

  async log(data: Omit<AdminAuditEvent, 'id' | 'timestamp'>): Promise<void> {
    const event: AdminAuditEvent = { ...data, ...this.stamp() }
    await this.record(event)

    logger.admin.debug('Admin audit event logged', {
      eventId: event.id,
      action: event.action,
      resource: event.resource,
      actor: actorName(event),
    })
  }

  getRecentEvents(options?: {
    limit?: number
    action?: string
    resource?: string
    actor?: string
    success?: boolean
    since?: Date
  }): AdminAuditEvent[] {
    const actorQuery = options?.actor?.toLowerCase()

    return this.selectEvents(
      options,
      event => !options?.action || options.action === 'all' || event.action === options.action,
      event => !options?.resource || options.resource === 'all' || event.resource === options.resource,
      event => !actorQuery || this.matchesActor(event, actorQuery),
      event => options?.success === undefined || event.success === options.success,
    )
  }

  protected computeAnalytics(recent: AdminAuditEvent[]): AdminAuditAnalytics {
    return {
      totalActions: recent.length,
      successRate: percent(recent.filter(event => event.success).length, recent.length, { round: true }),
      actionsByType: countBy(recent, event => event.action),
      actionsByResource: countBy(recent, event => event.resource),
      topActors: topEntries(tallyBy(recent, actorName)).map(([username, count]) => ({ username, count })),
      hourlyStats: bucketByHour(
        recent,
        () => ({ success: 0, failure: 0 }),
        (bucket, event) => {
          if (event.success) bucket.success++
          else bucket.failure++
        },
      ).map(({ hour, success, failure }) => ({ hour, success, failure, total: success + failure })),
      recentFailures: recent.filter(event => !event.success).slice(0, 20),
    }
  }

  private matchesActor(event: AdminAuditEvent, query: string): boolean {
    return (event.actor.username?.toLowerCase().includes(query) ?? false)
      || event.actor.sub.toLowerCase().includes(query)
      || (event.actor.email?.toLowerCase().includes(query) ?? false)
  }
}

export const adminAuditLogger = new AdminAuditLogger()
