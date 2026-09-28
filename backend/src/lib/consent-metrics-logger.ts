// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Consent Metrics Logger
 *
 * Persists consent (and IAL) decisions over the shared EventJournal and
 * snapshots analytics beside the event log for the admin dashboard.
 */

import { logger } from './logger'
import type { EnforcementMode } from './enforcement-mode'
import { EventJournal } from './events/journal'
import { average, bucketByHour, countBy, percent, tallyBy, topEntries } from './events/aggregate'

export interface ConsentDecisionEvent {
  id: string
  timestamp: string
  decision: 'permit' | 'deny'
  enforced: boolean
  mode: EnforcementMode
  consentId: string | null
  patientId: string | null
  clientId: string
  userId: string | null
  username: string | null
  resourceType: string | null
  resourcePath: string
  serverName: string
  method: string
  reason: string
  cached: boolean
  checkDurationMs: number
  /** Only present for combined consent + identity-assurance checks. */
  ial?: {
    allowed: boolean
    actualLevel: string | null
    requiredLevel: string
    isSensitiveResource: boolean
  } | null
}

export interface ConsentAnalytics {
  totalDecisions: number
  permitRate: number
  denyRate: number
  averageCheckDuration: number
  cacheHitRate: number
  decisionsByMode: Record<string, number>
  decisionsByResourceType: Record<string, { permit: number; deny: number }>
  topDeniedClients: Array<{ clientId: string; denyCount: number }>
  topDeniedPatients: Array<{ patientId: string; denyCount: number }>
  hourlyStats: Array<{
    hour: string
    permit: number
    deny: number
    total: number
  }>
}

const isDeny = (event: ConsentDecisionEvent): boolean => event.decision === 'deny'

class ConsentMetricsLogger extends EventJournal<ConsentDecisionEvent, ConsentAnalytics> {
  constructor() {
    super({
      logSubdir: 'consent-metrics',
      logFilename: 'consent-events.jsonl',
      analyticsFilename: 'consent-analytics.json',
      idPrefix: 'consent',
      channel: logger.consent,
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
