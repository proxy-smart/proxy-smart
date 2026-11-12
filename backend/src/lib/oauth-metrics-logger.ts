// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * OAuth Metrics Logger
 *
 * OAuth flow events over the shared EventJournal, plus the two aggregations
 * only this dashboard has: an hour-ahead trend forecast and weekday profiles.
 */

import { logger } from './logger'
import { EventJournal } from './events/journal'
import { average, bucketByHour, countBy, percent, topEntries } from './events/aggregate'
import { matchesSchema } from './type-guards'
import {
  OAuthEvent,
  type OAuthEventType,
  type MonitoringHealthResponseType,
  type OAuthPredictiveInsightsType,
  type OAuthWeekdayInsightType
} from '../schemas/monitoring'

export type OAuthFlowEvent = OAuthEventType
type OAuthPredictiveInsights = OAuthPredictiveInsightsType
type OAuthWeekdayInsight = OAuthWeekdayInsightType

export interface OAuthAnalytics {
  totalFlows: number
  successfulFlows: number
  successRate: number
  averageResponseTime: number
  activeTokens: number
  topClients: Array<{
    clientId: string
    clientName: string
    count: number
    successRate: number
  }>
  flowsByType: Record<string, number>
  errorsByType: Record<string, number>
  hourlyStats: Array<{
    hour: string
    success: number
    error: number
    total: number
  }>
  predictiveInsights?: OAuthPredictiveInsights
  weekdayInsights?: OAuthWeekdayInsight[]
}

type HourlyStats = OAuthAnalytics['hourlyStats']

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const isSuccess = (event: OAuthFlowEvent): boolean => event.status === 'success'

/** The session behind the refresh token is over (idle timeout, sign-out, access withdrawn): the endpoint answered correctly. */
const isEndedSession = (event: OAuthFlowEvent): boolean =>
  event.status === 'error' && event.grantType === 'refresh_token' && event.errorCode === 'invalid_grant'

/** An access token this proxy issued that has not expired yet; revocations are not subtracted. */
const isUnexpiredToken = (event: OAuthFlowEvent, now: number): boolean =>
  isSuccess(event) && event.type === 'token' && event.expiresIn !== undefined
  && Date.parse(event.timestamp) + event.expiresIn * 1000 > now

/** Fewer flows than this say too little to call the token endpoint degraded or down. */
export const HEALTH_MIN_SAMPLE = 10
export const ERROR_RATE_DEGRADED_PERCENT = 10
export const ERROR_RATE_UNHEALTHY_PERCENT = 50
/** Token requests go through Keycloak, so a few hundred ms is normal. */
export const RESPONSE_TIME_ALERT_MS = 1000

type HealthStatus = MonitoringHealthResponseType['oauthServer']['status']

export class OAuthMetricsLogger extends EventJournal<OAuthFlowEvent, OAuthAnalytics> {
  /** `logDir` overrides logs/oauth-metrics; tests point it at a temp dir. */
  constructor(logDir?: string) {
    super({
      logDir,
      logSubdir: 'oauth-metrics',
      logFilename: 'oauth-events.jsonl',
      analyticsFilename: 'oauth-analytics.json',
      idPrefix: 'oauth',
      channel: logger.auth,
      isEvent: matchesSchema(OAuthEvent),
      loadWindowMs: 24 * 60 * 60 * 1000,
    })
  }

  async logEvent(data: Omit<OAuthFlowEvent, 'id' | 'timestamp'>): Promise<void> {
    const event: OAuthFlowEvent = { ...data, ...this.stamp() }
    await this.record(event)

    logger.auth.debug('OAuth event logged', {
      eventId: event.id,
      type: event.type,
      status: event.status,
      clientId: event.clientId,
    })
  }

  getRecentEvents(options?: {
    limit?: number
    type?: string
    status?: string
    clientId?: string
    since?: Date
  }): OAuthFlowEvent[] {
    return this.selectEvents(
      options,
      event => !options?.type || options.type === 'all' || event.type === options.type,
      event => !options?.status || options.status === 'all' || event.status === options.status,
      event => !options?.clientId || event.clientId === options.clientId,
    )
  }

  protected computeAnalytics(recent: OAuthFlowEvent[]): OAuthAnalytics {
    const now = Date.now()
    const clientStats = new Map<string, { name: string; count: number; successful: number }>()
    for (const event of recent) {
      const stat = clientStats.get(event.clientId)
        ?? { name: event.clientName || event.clientId, count: 0, successful: 0 }
      stat.count++
      if (isSuccess(event)) stat.successful++
      clientStats.set(event.clientId, stat)
    }

    const hourlyStats: HourlyStats = bucketByHour(
      recent,
      () => ({ success: 0, error: 0 }),
      (bucket, event) => {
        if (isSuccess(event)) bucket.success++
        else bucket.error++
      },
    ).map(({ hour, success, error }) => ({ hour, success, error, total: success + error }))

    const errorsByType = countBy(
      recent.filter(event => event.status === 'error'),
      event => event.errorCode || 'unknown',
    )

    return {
      totalFlows: recent.length,
      successfulFlows: recent.filter(isSuccess).length,
      successRate: percent(recent.filter(isSuccess).length, recent.length),
      averageResponseTime: average(recent.map(event => event.responseTime)),
      activeTokens: recent.filter(event => isUnexpiredToken(event, now)).length,
      topClients: topEntries(new Map(Array.from(clientStats, ([clientId, stat]) => [clientId, stat.count])))
        .map(([clientId, count]) => {
          const stat = clientStats.get(clientId)
          return {
            clientId,
            clientName: stat?.name ?? clientId,
            count,
            successRate: percent(stat?.successful ?? 0, count),
          }
        }),
      flowsByType: countBy(recent, event => event.grantType),
      errorsByType,
      hourlyStats,
      predictiveInsights: this.computePredictiveInsights(hourlyStats, errorsByType) ?? undefined,
      weekdayInsights: this.computeWeekdayInsights(this.events) ?? undefined,
    }
  }

  /** The OAuth health the dashboard shows, from the analytics the last pass produced. */
  healthSnapshot(): MonitoringHealthResponseType {
    const analytics = this.getAnalytics()
    const judged = this.eventsInWindow().filter(event => !isEndedSession(event))
    const flows = judged.length
    const errorRate = flows > 0 ? 100 - percent(judged.filter(isSuccess).length, flows) : 0
    const responseTime = analytics?.averageResponseTime ?? 0
    const sampled = flows >= HEALTH_MIN_SAMPLE
    const failing: HealthStatus = sampled && errorRate >= ERROR_RATE_UNHEALTHY_PERCENT
      ? 'unhealthy'
      : sampled && errorRate >= ERROR_RATE_DEGRADED_PERCENT ? 'degraded' : 'healthy'
    const slow = sampled && responseTime > RESPONSE_TIME_ALERT_MS
    const oldest = this.events[this.events.length - 1]
    const truncated = this.events.length >= this.ringBufferSize
      && oldest !== undefined && Date.parse(oldest.timestamp) > Date.now() - this.analyticsWindowMs

    const alerts: MonitoringHealthResponseType['alerts'] = []
    if (failing !== 'healthy') {
      alerts.push({ type: failing === 'unhealthy' ? 'error' : 'warning', message: `${errorRate.toFixed(0)}% of the last ${flows} OAuth requests failed` })
    }
    if (slow) {
      alerts.push({ type: 'warning', message: `OAuth requests averaged ${responseTime.toFixed(0)} ms over the last ${flows}` })
    }
    if (truncated) {
      const hours = ((Date.now() - Date.parse(oldest.timestamp)) / 3_600_000).toFixed(1)
      alerts.push({ type: 'info', message: `Analytics cover only the last ${hours} h: the event buffer holds ${this.ringBufferSize} events` })
    }

    return {
      oauthServer: {
        status: failing === 'healthy' && slow ? 'degraded' : failing,
        uptime: process.uptime(),
        responseTime,
      },
      tokenStore: {
        status: truncated ? 'degraded' : 'healthy',
        activeTokens: analytics?.activeTokens ?? 0,
        storageUsed: Math.round((this.events.length / this.ringBufferSize) * 100),
      },
      network: {
        status: failing,
        throughput: this.getThroughputPerMinute(),
        errorRate,
      },
      alerts,
      timestamp: new Date().toISOString(),
    }
  }


  /**
   * Next-hour projection from the last six hour buckets.
   *
   * Returns null rather than a pseudo-forecast when there is too little data or
   * no traffic at all — the dashboard hides the panel instead of charting noise.
   */
  private computePredictiveInsights(
    hourlyStats: HourlyStats,
    errorsByType: Record<string, number>,
  ): OAuthPredictiveInsights | null {
    if (hourlyStats.length < 4) return null

    const recent = hourlyStats.slice(-6).filter(stat => Number.isFinite(stat.total))
    if (recent.length < 3) return null
    if (recent.reduce((sum, stat) => sum + stat.total, 0) === 0) return null

    const { slope: volumeSlope, direction: trendDirection, confidence: volumeConfidence } =
      computeLinearTrend(recent.map(stat => stat.total))
    const { slope: successSlope } =
      computeLinearTrend(recent.map(stat => percent(stat.success, stat.total)))

    const latest = recent[recent.length - 1]
    const latestSuccessRate = percent(latest.success, latest.total)
    const predictedTotal = Math.max(0, Math.round(latest.total + volumeSlope))
    const predictedSuccessRate = clampPercent(latestSuccessRate + successSlope)
    const predictedErrorRate = clampPercent(100 - predictedSuccessRate)

    const priorErrorRates = recent.slice(0, -1).map(stat => percent(stat.error, stat.total))
    const averageErrorRate = average(priorErrorRates)
    const stdDeviation = Math.sqrt(
      average(priorErrorRates.map(rate => Math.pow(rate - averageErrorRate, 2))),
    )
    const lastErrorRate = percent(latest.error, latest.total)

    let anomalyRisk: 'low' | 'medium' | 'high' = 'low'
    const anomalyReasons: string[] = []

    if (priorErrorRates.length >= 2) {
      if (lastErrorRate > averageErrorRate + 2 * stdDeviation && lastErrorRate > 5) {
        anomalyRisk = 'high'
        anomalyReasons.push('Error rate spiked significantly in the last hour')
      } else if (lastErrorRate > averageErrorRate + stdDeviation) {
        anomalyRisk = 'medium'
        anomalyReasons.push('Error rate is trending upward')
      }
    }

    if (trendDirection === 'increasing' && predictedErrorRate > 10) {
      anomalyRisk = anomalyRisk === 'high' ? 'high' : 'medium'
      anomalyReasons.push('Increasing traffic with elevated projected error rate')
    }

    const [topErrorType] = topEntries(new Map(Object.entries(errorsByType)), 1).map(([type]) => type)
    if (topErrorType) {
      anomalyReasons.push(`Dominant error category: ${topErrorType}`)
    }
    if (anomalyReasons.length === 0) {
      anomalyReasons.push('No anomalies detected in the last six hours')
    }

    return {
      generatedAt: new Date().toISOString(),
      trendDirection,
      trendConfidence: Math.max(0, Math.min(1, volumeConfidence)),
      nextHour: {
        totalFlows: predictedTotal,
        successRate: Number(predictedSuccessRate.toFixed(1)),
        errorRate: Number(predictedErrorRate.toFixed(1)),
      },
      anomalyRisk,
      anomalyReasons,
      notes: anomalyRisk === 'high'
        ? 'Investigate failing clients or infrastructure issues impacting OAuth flows.'
        : undefined,
    }
  }

  private computeWeekdayInsights(events: OAuthFlowEvent[]): OAuthWeekdayInsight[] | null {
    const cutoff = Date.now() - WEEK_MS
    const weekly = events.filter(event => Date.parse(event.timestamp) >= cutoff)
    if (weekly.length === 0) return null

    const byDate = new Map<string, { total: number; success: number; lastTimestamp: Date }>()
    for (const event of weekly) {
      const at = new Date(event.timestamp)
      const dateKey = at.toISOString().slice(0, 10)
      const entry = byDate.get(dateKey) ?? { total: 0, success: 0, lastTimestamp: at }
      entry.total++
      if (isSuccess(event)) entry.success++
      if (at > entry.lastTimestamp) entry.lastTimestamp = at
      byDate.set(dateKey, entry)
    }

    const byWeekday = new Map<number, Array<{ total: number; successRate: number; timestamp: Date }>>()
    for (const entry of byDate.values()) {
      const weekday = entry.lastTimestamp.getUTCDay()
      const days = byWeekday.get(weekday) ?? []
      days.push({
        total: entry.total,
        successRate: percent(entry.success, entry.total),
        timestamp: entry.lastTimestamp,
      })
      byWeekday.set(weekday, days)
    }

    const insights: OAuthWeekdayInsight[] = []
    for (const [weekday, days] of byWeekday) {
      if (days.length === 0) continue

      const averageTotal = average(days.map(day => day.total))
      const averageSuccessRate = average(days.map(day => day.successRate))
      const latest = days.slice().sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]
      const deltaFromAverage = ((latest.total - averageTotal) / (averageTotal || 1)) * 100

      insights.push({
        weekday,
        label: WEEKDAY_LABELS[weekday],
        sampleDays: days.length,
        averageTotal: Number(averageTotal.toFixed(1)),
        averageSuccessRate: Number(averageSuccessRate.toFixed(1)),
        averageErrorRate: Number((100 - averageSuccessRate).toFixed(1)),
        projectedTotal: Math.max(0, Math.round(averageTotal)),
        projectedSuccessRate: Number(averageSuccessRate.toFixed(1)),
        projectedErrorRate: Number((100 - averageSuccessRate).toFixed(1)),
        latestTotal: latest.total,
        deltaFromAverage: Number(deltaFromAverage.toFixed(1)),
        lastObserved: latest.timestamp.toISOString(),
      })
    }

    return insights.length > 0 ? insights.sort((a, b) => a.weekday - b.weekday) : null
  }
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value))

function computeLinearTrend(values: number[]): {
  slope: number
  direction: 'increasing' | 'decreasing' | 'stable'
  confidence: number
} {
  const numeric = values.filter(value => Number.isFinite(value))
  const n = numeric.length
  if (n < 2) return { slope: 0, direction: 'stable', confidence: 0 }

  const sumX = numeric.reduce((acc, _, idx) => acc + idx, 0)
  const sumY = numeric.reduce((acc, value) => acc + value, 0)
  const sumXY = numeric.reduce((acc, value, idx) => acc + idx * value, 0)
  const sumX2 = numeric.reduce((acc, _, idx) => acc + idx * idx, 0)

  const denominator = n * sumX2 - sumX * sumX
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator

  const threshold = Math.max(1, numeric[n - 1] * 0.05)
  let direction: 'increasing' | 'decreasing' | 'stable' = 'stable'
  if (slope > threshold) direction = 'increasing'
  else if (slope < -threshold) direction = 'decreasing'

  const mean = sumY / n
  const variance = average(numeric.map(value => Math.pow(value - mean, 2)))
  const confidence = mean === 0 ? 0 : Math.min(1, Math.abs(slope) / (mean + Math.sqrt(variance) + 1))

  return { slope, direction, confidence }
}

export const oauthMetricsLogger = new OAuthMetricsLogger()
