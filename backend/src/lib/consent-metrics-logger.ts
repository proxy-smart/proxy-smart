// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Consent Metrics Logger
 *
 * Persists consent (and IAL) decisions over the shared EventJournal and
 * snapshots analytics beside the event log for the admin dashboard.
 */

import { logger } from './logger'
import { EventJournal } from './events/journal'
import type { AccessLogFilters } from './consent/access-log'
import { average, bucketByHour, countBy, percent, tallyBy, topEntries } from './events/aggregate'
import { matchesSchema } from './type-guards'
import { ConsentDecisionEvent as ConsentDecisionEventSchema, type ConsentAnalyticsType, type ConsentDecisionEventType } from '@/schemas/consent-monitoring'

export type ConsentDecisionEvent = ConsentDecisionEventType
export type ConsentAnalytics = ConsentAnalyticsType

const isDeny = (event: ConsentDecisionEvent): boolean => event.decision === 'deny'

class ConsentMetricsLogger extends EventJournal<ConsentDecisionEvent, ConsentAnalytics> {
  constructor() {
    super({
      logSubdir: 'consent-metrics',
      logFilename: 'consent-events.jsonl',
      analyticsFilename: 'consent-analytics.json',
      idPrefix: 'consent',
      channel: logger.consent,
      isEvent: matchesSchema(ConsentDecisionEventSchema),
      loadWindowMs: 24 * 60 * 60 * 1000,
    })
  }

  async logDecision(data: Omit<ConsentDecisionEvent, 'id' | 'timestamp'>): Promise<void> {
    await this.record({ ...data, ...this.stamp() })
  }

  getRecentEvents(options?: {
    limit?: number
    decision?: string
    clientId?: string
    patientId?: string
    resourceType?: string
    since?: Date
  }): ConsentDecisionEvent[] {
    return this.selectEvents(
      options,
      event => !options?.decision || options.decision === 'all' || event.decision === options.decision,
      event => !options?.clientId || event.clientId === options.clientId,
      event => !options?.patientId || event.patientId === options.patientId,
      event => !options?.resourceType
        || options.resourceType === 'all'
        || event.resourceType === options.resourceType,
    )
  }

  /** One patient's decisions; the id is required so a missing patient can never read as "all patients". */
  patientAccessLog(patientId: string, filters: AccessLogFilters): ConsentDecisionEvent[] {
    return this.getRecentEvents({ ...filters, patientId })
  }

  protected computeAnalytics(recent: ConsentDecisionEvent[]): ConsentAnalytics {
    const total = recent.length
    const denied = recent.filter(isDeny)

    const decisionsByResourceType: Record<string, { permit: number; deny: number }> = {}
    for (const event of recent) {
      const resourceType = event.resourceType ?? 'unknown'
      const bucket = decisionsByResourceType[resourceType] ?? { permit: 0, deny: 0 }
      bucket[event.decision]++
      decisionsByResourceType[resourceType] = bucket
    }

    return {
      totalDecisions: total,
      permitRate: percent(total - denied.length, total),
      denyRate: percent(denied.length, total),
      averageCheckDuration: average(recent.map(event => event.checkDurationMs)),
      cacheHitRate: percent(recent.filter(event => event.cached).length, total),
      decisionsByMode: countBy(recent, event => event.mode),
      decisionsByResourceType,
      topDeniedClients: topEntries(tallyBy(denied, event => event.clientId))
        .map(([clientId, denyCount]) => ({ clientId, denyCount })),
      topDeniedPatients: topEntries(tallyBy(denied, event => event.patientId))
        .map(([patientId, denyCount]) => ({ patientId, denyCount })),
      hourlyStats: bucketByHour(
        recent,
        () => ({ permit: 0, deny: 0 }),
        (bucket, event) => {
          if (isDeny(event)) bucket.deny++
          else bucket.permit++
        },
      ).map(({ hour, permit, deny }) => ({ hour, permit, deny, total: permit + deny })),
    }
  }
}

export const consentMetricsLogger = new ConsentMetricsLogger()
