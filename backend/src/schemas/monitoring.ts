// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

/**
 * OAuth monitoring and analytics response schemas
 */

// ==================== Stream Response ====================

export const StreamResponse = t.Object({}, { additionalProperties: true, title: 'StreamResponse' })

export type StreamResponseType = Static<typeof StreamResponse>

// ==================== Alert Response ====================

export const AlertInfo = t.Object({
  type: t.String({ description: 'Alert type (info, warning, error)' }),
  message: t.String({ description: 'Alert message' })
}, { title: 'AlertInfo' })

export type AlertInfoType = Static<typeof AlertInfo>

// ==================== Monitoring Health Response ====================

export const MonitoringHealthResponse = t.Object({
  oauthServer: t.Object({
    status: t.String({ description: 'OAuth server status' }),
    uptime: t.Number({ description: 'Server uptime in seconds' }),
    responseTime: t.Number({ description: 'Average response time in ms' })
  }),
  tokenStore: t.Object({
    status: t.String({ description: 'Token store status' }),
    activeTokens: t.Number({ description: 'Number of active tokens' }),
    storageUsed: t.Number({ description: 'Storage used percentage' })
  }),
  network: t.Object({
    status: t.String({ description: 'Network status' }),
    throughput: t.Number({ description: 'Requests per minute (measured over last 60s)' }),
    errorRate: t.Number({ description: 'Error rate percentage' })
  }),
  alerts: t.Array(AlertInfo, { description: 'System alerts' }),
  timestamp: t.String({ description: 'Timestamp (ISO 8601)' })
}, { title: 'MonitoringHealthResponse' })

export type MonitoringHealthResponseType = Static<typeof MonitoringHealthResponse>

// ==================== Export Response ====================

export const ExportResponse = t.Object({
  format: t.String({ description: 'Export format (json, csv)' }),
  data: t.Any()
}, { title: 'ExportResponse' })

export type ExportResponseType = Static<typeof ExportResponse>

// ==================== OAuth Events Response ====================

export const OAuthEventFhirContext = t.Object({
  patient: t.Optional(t.String({ description: 'Patient ID' })),
  encounter: t.Optional(t.String({ description: 'Encounter ID' })),
  location: t.Optional(t.String({ description: 'Location ID' })),
  fhirUser: t.Optional(t.String({ description: 'FHIR User ID' }))
}, { title: 'OAuthEventFhirContext' })

export type OAuthEventFhirContextType = Static<typeof OAuthEventFhirContext>

export const OAuthEvent = t.Object({
  id: t.String({ description: 'Event ID' }),
  timestamp: t.String({ description: 'Event timestamp' }),
  type: t.String({ description: 'Event type' }),
  status: t.String({ description: 'Event status' }),
  clientId: t.String({ description: 'OAuth client ID' }),
  clientName: t.Optional(t.String({ description: 'Client display name' })),
  userId: t.Optional(t.String({ description: 'User ID' })),
  userName: t.Optional(t.String({ description: 'User name' })),
  scopes: t.Array(t.String(), { description: 'Requested scopes' }),
  grantType: t.String({ description: 'OAuth grant type' }),
  actorChain: t.Optional(t.Array(t.String(), { description: 'RFC 8693 actor chain of an exchanged token, current client first, originating app last' })),
  responseTime: t.Number({ description: 'Response time in ms' }),
  ipAddress: t.String({ description: 'Client IP address' }),
  userAgent: t.String({ description: 'User agent' }),
  errorMessage: t.Optional(t.String({ description: 'Error message if failed' })),
  errorCode: t.Optional(t.String({ description: 'Error code' })),
  tokenType: t.Optional(t.String({ description: 'Token type' })),
  expiresIn: t.Optional(t.Number({ description: 'Token expiration in seconds' })),
  refreshToken: t.Optional(t.Boolean({ description: 'Whether refresh token was issued' })),
  fhirContext: t.Optional(OAuthEventFhirContext),
  requestDetails: t.Optional(t.Object({
    path: t.String({ description: 'Requested path' }),
    method: t.String({ description: 'HTTP method' }),
    headers: t.Optional(t.Record(t.String(), t.String(), { description: 'Request headers' }))
  }, { description: 'HTTP request context' }))
}, { title: 'OAuthEvent' })

export type OAuthEventType = Static<typeof OAuthEvent>

export const OAuthEventsResponse = t.Object({
  events: t.Array(OAuthEvent, { description: 'Array of events' }),
  total: t.Number({ description: 'Total number of events' }),
  timestamp: t.String({ description: 'Response timestamp' })
}, { title: 'OAuthEventsResponse' })

export type OAuthEventsResponseType = Static<typeof OAuthEventsResponse>

// ==================== OAuth Analytics Response ====================

export const OAuthAnalyticsTopClient = t.Object({
  clientId: t.String({ description: 'OAuth client ID' }),
  clientName: t.String({ description: 'Client display name' }),
  count: t.Number({ description: 'Number of requests' }),
  successRate: t.Number({ description: 'Success rate percentage' })
}, { title: 'OAuthAnalyticsTopClient' })

export type OAuthAnalyticsTopClientType = Static<typeof OAuthAnalyticsTopClient>

export const OAuthAnalyticsHourlyStats = t.Object({
  hour: t.String({ description: 'Hour timestamp (ISO 8601)' }),
  success: t.Number({ description: 'Successful requests' }),
  error: t.Number({ description: 'Failed requests' }),
  total: t.Number({ description: 'Total requests' })
}, { title: 'OAuthAnalyticsHourlyStats' })

export type OAuthAnalyticsHourlyStatsType = Static<typeof OAuthAnalyticsHourlyStats>

export const OAuthPredictiveInsights = t.Object({
  generatedAt: t.String({ description: 'Timestamp when the prediction was generated' }),
  trendDirection: t.Union([
    t.Literal('increasing'),
    t.Literal('decreasing'),
    t.Literal('stable')
  ], { description: 'Traffic trend direction' }),
  trendConfidence: t.Number({ description: 'Confidence score for the trend (0-1)' }),
  nextHour: t.Object({
    totalFlows: t.Number({ description: 'Predicted total OAuth flows for the next hour' }),
    successRate: t.Number({ description: 'Predicted success rate percentage for the next hour' }),
    errorRate: t.Number({ description: 'Predicted error rate percentage for the next hour' })
  }, { description: 'Forecast for the next hour' }),
  anomalyRisk: t.Union([
    t.Literal('low'),
    t.Literal('medium'),
    t.Literal('high')
  ], { description: 'Estimated anomaly risk level' }),
  anomalyReasons: t.Array(t.String({ description: 'Drivers that influenced the risk score' })),
  notes: t.Optional(t.String({ description: 'Human-readable guidance or recommendation' }))
}, { title: 'OAuthPredictiveInsights' })

export type OAuthPredictiveInsightsType = Static<typeof OAuthPredictiveInsights>

export const OAuthWeekdayInsight = t.Object({
  weekday: t.Number({ description: 'Day of the week (0-6, Sunday based on UTC)' }),
  label: t.String({ description: 'Weekday label' }),
  sampleDays: t.Number({ description: 'Number of observed days contributing to this insight' }),
  averageTotal: t.Number({ description: 'Average total flows for the weekday' }),
  averageSuccessRate: t.Number({ description: 'Average success rate percentage for the weekday' }),
  averageErrorRate: t.Number({ description: 'Average error rate percentage for the weekday' }),
  projectedTotal: t.Number({ description: 'Projected total flows for the next occurrence' }),
  projectedSuccessRate: t.Number({ description: 'Projected success rate percentage for the next occurrence' }),
  projectedErrorRate: t.Number({ description: 'Projected error rate percentage for the next occurrence' }),
  latestTotal: t.Optional(t.Number({ description: 'Most recent total flow count observed' })),
  deltaFromAverage: t.Optional(t.Number({ description: 'Percentage delta from the weekday average' })),
  lastObserved: t.Optional(t.String({ description: 'Timestamp of the most recent observation' }))
}, { title: 'OAuthWeekdayInsight' })

export type OAuthWeekdayInsightType = Static<typeof OAuthWeekdayInsight>

export const OAuthAnalyticsResponse = t.Object({
  totalRequests: t.Number({ description: 'Total requests in period' }),
  successfulRequests: t.Number({ description: 'Successful requests' }),
  failedRequests: t.Number({ description: 'Failed requests' }),
  successRate: t.Number({ description: 'Success rate percentage' }),
  averageResponseTime: t.Number({ description: 'Average response time in ms' }),
  activeTokens: t.Number({ description: 'Currently active tokens' }),
  topClients: t.Array(OAuthAnalyticsTopClient, { description: 'Top OAuth clients by request count' }),
  flowsByType: t.Record(t.String(), t.Number(), { description: 'OAuth flows by type' }),
  errorsByType: t.Record(t.String(), t.Number(), { description: 'Errors by type' }),
  hourlyStats: t.Array(OAuthAnalyticsHourlyStats, { description: 'Hourly statistics' }),
  timestamp: t.String({ description: 'Response timestamp' }),
  predictiveInsights: t.Optional(OAuthPredictiveInsights),
  weekdayInsights: t.Optional(t.Array(OAuthWeekdayInsight, { description: 'Insights aggregated by weekday' }))
}, { title: 'OAuthAnalyticsResponse' })

export type OAuthAnalyticsResponseType = Static<typeof OAuthAnalyticsResponse>

// ==================== FHIR Health Monitoring ====================

export const FhirHealthCheckSchema = t.Object({
  id: t.String({ description: 'Unique check ID' }),
  timestamp: t.String({ description: 'Check timestamp (ISO 8601)' }),
  serverName: t.String({ description: 'FHIR server display name' }),
  serverUrl: t.String({ description: 'FHIR server base URL' }),
  status: t.UnionEnum(['healthy', 'degraded', 'unhealthy'], { description: 'Health status' }),
  responseTimeMs: t.Number({ description: 'Response time in milliseconds' }),
  fhirVersion: t.Optional(t.String({ description: 'Detected FHIR version' })),
  error: t.Optional(t.String({ description: 'Error message if unhealthy' })),
}, { title: 'FhirHealthCheck' })

export type FhirHealthCheckSchemaType = Static<typeof FhirHealthCheckSchema>

export const FhirUptimeSummarySchema = t.Object({
  serverName: t.String({ description: 'FHIR server display name' }),
  serverUrl: t.String({ description: 'FHIR server base URL' }),
  currentStatus: t.UnionEnum(['healthy', 'degraded', 'unhealthy'], { description: 'Current status' }),
  uptimePercent: t.Number({ description: 'Uptime percentage over observation period' }),
  avgResponseTimeMs: t.Number({ description: 'Average response time in ms' }),
  checksTotal: t.Number({ description: 'Total number of checks' }),
  checksHealthy: t.Number({ description: 'Number of healthy checks' }),
  lastChecked: t.String({ description: 'Timestamp of last check (ISO 8601)' }),
  lastError: t.Optional(t.String({ description: 'Most recent error message' })),
  recentChecks: t.Array(FhirHealthCheckSchema, { description: 'Recent health check results' }),
}, { title: 'FhirUptimeSummary' })

export type FhirUptimeSummarySchemaType = Static<typeof FhirUptimeSummarySchema>

export const FhirHealthChecksResponse = t.Object({
  checks: t.Array(FhirHealthCheckSchema, { description: 'Health check history' }),
  total: t.Number({ description: 'Total checks returned' }),
  timestamp: t.String({ description: 'Response timestamp' }),
}, { title: 'FhirHealthChecksResponse' })

export type FhirHealthChecksResponseType = Static<typeof FhirHealthChecksResponse>

export const FhirUptimeSummariesResponse = t.Object({
  servers: t.Array(FhirUptimeSummarySchema, { description: 'Per-server uptime summaries' }),
  timestamp: t.String({ description: 'Response timestamp' }),
}, { title: 'FhirUptimeSummariesResponse' })

export type FhirUptimeSummariesResponseType = Static<typeof FhirUptimeSummariesResponse>

// ==================== FHIR Proxy Metrics ====================

export const FhirProxyEventSchema = t.Object({
  id: t.String({ description: 'Unique event ID' }),
  timestamp: t.String({ description: 'Event timestamp (ISO 8601)' }),
  serverName: t.String({ description: 'Target FHIR server name' }),
  method: t.String({ description: 'HTTP method (GET, POST, etc.)' }),
  resourcePath: t.String({ description: 'FHIR resource path' }),
  resourceType: t.String({ description: 'FHIR resource type' }),
  statusCode: t.Number({ description: 'HTTP response status code' }),
  responseTimeMs: t.Number({ description: 'Response time in milliseconds' }),
  clientId: t.Optional(t.String({ description: 'OAuth client ID' })),
  userId: t.Optional(t.String({ description: 'Authenticated user ID' })),
  username: t.Optional(t.String({ description: 'Authenticated username' })),
  error: t.Optional(t.String({ description: 'Error description' })),
}, { title: 'FhirProxyEvent' })

export type FhirProxyEventSchemaType = Static<typeof FhirProxyEventSchema>

export const FhirProxyHourlyStat = t.Object({
  hour: t.String({ description: 'Hour bucket (ISO 8601)' }),
  total: t.Number(),
  success: t.Number(),
  errors: t.Number(),
  rateLimited: t.Number(),
  avgMs: t.Number(),
}, { title: 'FhirProxyHourlyStat' })

export const FhirProxyAnalyticsSchema = t.Object({
  totalRequests: t.Number({ description: 'Total proxied requests in last 24h' }),
  successCount: t.Number({ description: 'Successful requests (2xx/3xx)' }),
  errorCount: t.Number({ description: 'Error requests (4xx/5xx)' }),
  rateLimitCount: t.Number({ description: 'Rate-limited requests (429)' }),
  successRate: t.Number({ description: 'Success rate percentage' }),
  avgResponseTimeMs: t.Number({ description: 'Average response time in ms' }),
  requestsByStatus: t.Record(t.String(), t.Number(), { description: 'Requests grouped by status code' }),
  requestsByServer: t.Record(t.String(), t.Number(), { description: 'Requests grouped by server name' }),
  requestsByResource: t.Record(t.String(), t.Number(), { description: 'Requests grouped by resource type' }),
  recentErrors: t.Array(FhirProxyEventSchema, { description: 'Recent error events' }),
  hourlyStats: t.Array(FhirProxyHourlyStat, { description: 'Hourly request statistics' }),
}, { title: 'FhirProxyAnalytics' })

export type FhirProxyAnalyticsSchemaType = Static<typeof FhirProxyAnalyticsSchema>

export const FhirProxyEventsResponse = t.Object({
  events: t.Array(FhirProxyEventSchema, { description: 'Proxy event history' }),
  total: t.Number({ description: 'Total events returned' }),
  timestamp: t.String({ description: 'Response timestamp' }),
}, { title: 'FhirProxyEventsResponse' })

export type FhirProxyEventsResponseType = Static<typeof FhirProxyEventsResponse>

export const FhirProxyAnalyticsResponse = t.Object({
  analytics: FhirProxyAnalyticsSchema,
  timestamp: t.String({ description: 'Response timestamp' }),
}, { title: 'FhirProxyAnalyticsResponse' })

export type FhirProxyAnalyticsResponseType = Static<typeof FhirProxyAnalyticsResponse>
