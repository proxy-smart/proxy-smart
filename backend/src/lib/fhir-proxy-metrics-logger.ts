// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * FHIR Proxy Metrics Logger
 *
 * Tracks every proxied FHIR request (status code, latency, resource type,
 * server, client, 429s / errors) over the shared EventJournal.
 */

import { logger } from './logger'
import { EventJournal } from './events/journal'
import { average, bucketByHour, countBy, percent } from './events/aggregate'

export interface FhirProxyEvent {
  id: string
  timestamp: string
  serverName: string
  method: string
  resourcePath: string
  resourceType: string
  statusCode: number
  responseTimeMs: number
  clientId?: string
  /** RFC 8693 actor chain when the token was exchanged, current client first */
  actorChain?: string[]
  userId?: string
  username?: string
  organizationId?: string
  error?: string
}

export interface FhirProxyAnalytics {
  totalRequests: number
  successCount: number
  errorCount: number
  rateLimitCount: number
  successRate: number
  avgResponseTimeMs: number
  requestsByStatus: Record<number, number>
  requestsByServer: Record<string, number>
  requestsByResource: Record<string, number>
  recentErrors: FhirProxyEvent[]
  hourlyStats: Array<{
    hour: string
    total: number
    success: number
    errors: number
    rateLimited: number
    avgMs: number
  }>
}

const MAX_MEMORY_EVENTS = 2000
/** The dashboard reads second-precision hour keys here. */
const HOUR_SUFFIX = ':00:00'

const isSuccess = (event: FhirProxyEvent): boolean => event.statusCode >= 200 && event.statusCode < 400
const isError = (event: FhirProxyEvent): boolean => event.statusCode >= 400
const isRateLimited = (event: FhirProxyEvent): boolean => event.statusCode === 429

class FhirProxyMetricsLogger extends EventJournal<FhirProxyEvent, FhirProxyAnalytics> {
  constructor() {
    super({
      logSubdir: 'fhir-proxy-metrics',
      logFilename: 'fhir-proxy-events.jsonl',
      idPrefix: 'fhir-px',
      channel: logger.fhir,
      ringBufferSize: MAX_MEMORY_EVENTS,
    })
  }

  async logRequest(data: Omit<FhirProxyEvent, 'id' | 'timestamp'>): Promise<void> {
    const event: FhirProxyEvent = { ...data, ...this.stamp() }
    await this.record(event)

    if (event.statusCode === 429) {
      logger.fhir.warn('FHIR proxy 429 rate limited', { server: event.serverName, path: event.resourcePath })
    } else if (event.statusCode >= 500) {
      logger.fhir.warn('FHIR proxy server error', {
        server: event.serverName,
        status: event.statusCode,
        path: event.resourcePath,
      })
    }
  }

  getRecentEvents(opts?: {
    limit?: number
    serverName?: string
    statusCode?: number
    since?: Date
  }): FhirProxyEvent[] {
    return this.selectEvents(
      opts,
      event => !opts?.serverName || event.serverName === opts.serverName,
      event => !opts?.statusCode || event.statusCode === opts.statusCode,
    )
  }

  /** Always fresh: the window moves on even when no request has come in. */
  getAnalytics(): FhirProxyAnalytics {
    return this.computeAnalytics(this.eventsInWindow())
  }

  protected computeAnalytics(recent: FhirProxyEvent[]): FhirProxyAnalytics {
    const requestsByStatus: Record<number, number> = {}
    for (const event of recent) {
      requestsByStatus[event.statusCode] = (requestsByStatus[event.statusCode] ?? 0) + 1
    }

    const successCount = recent.filter(isSuccess).length

    return {
      totalRequests: recent.length,
      successCount,
      errorCount: recent.filter(isError).length,
      rateLimitCount: recent.filter(isRateLimited).length,
      successRate: percent(successCount, recent.length),
      avgResponseTimeMs: average(recent.map(event => event.responseTimeMs), { round: true }),
      requestsByStatus,
      requestsByServer: countBy(recent, event => event.serverName),
      requestsByResource: countBy(recent, event => event.resourceType),
      recentErrors: recent.filter(isError).slice(0, 20),
      hourlyStats: bucketByHour(
        recent,
        () => ({ total: 0, success: 0, errors: 0, rateLimited: 0, totalMs: 0 }),
        (bucket, event) => {
          bucket.total++
          bucket.totalMs += event.responseTimeMs
          if (isSuccess(event)) bucket.success++
          if (isError(event)) bucket.errors++
          if (isRateLimited(event)) bucket.rateLimited++
        },
        HOUR_SUFFIX,
      ).map(({ hour, total, success, errors, rateLimited, totalMs }) => ({
        hour,
        total,
        success,
        errors,
        rateLimited,
        avgMs: Math.round(totalMs / total),
      })),
    }
  }
}

export const fhirProxyMetricsLogger = new FhirProxyMetricsLogger()
