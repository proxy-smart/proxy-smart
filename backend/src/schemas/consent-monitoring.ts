// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'
import { ConsentDecision, ConsentMode } from './consent'
import { buildEventsResponse } from './event-monitoring'

const NullableString = (description: string) => t.Union([t.String(), t.Null()], { description })

export const ConsentIalSummary = t.Object({
  allowed: t.Boolean({ description: 'Whether the identity assurance level sufficed' }),
  actualLevel: NullableString('IAL the user holds'),
  requiredLevel: t.String({ description: 'IAL the resource requires' }),
  isSensitiveResource: t.Boolean({ description: 'Whether the resource type is marked sensitive' }),
}, { title: 'ConsentIalSummary' })

export const ConsentDecisionEvent = t.Object({
  id: t.String({ description: 'Unique event ID' }),
  timestamp: t.String({ description: 'When the decision was made (ISO 8601)' }),
  decision: ConsentDecision,
  enforced: t.Boolean({ description: 'Whether a deny was enforced (false in audit-only mode)' }),
  mode: ConsentMode,
  consentId: NullableString('Consent that decided, when one did'),
  patientId: NullableString('Patient the request concerns'),
  clientId: t.String({ description: 'Client that made the request' }),
  userId: NullableString('User who made the request, when known'),
  username: NullableString('Username of that user'),
  resourceType: NullableString('FHIR resource type requested'),
  resourcePath: t.String({ description: 'Requested FHIR path' }),
  serverName: t.String({ description: 'FHIR server the request went to' }),
  method: t.String({ description: 'HTTP method' }),
  reason: t.String({ description: 'Why consent permitted or denied the request' }),
  cached: t.Boolean({ description: 'Whether the decision came from the consent cache' }),
  checkDurationMs: t.Number({ description: 'Time the check took in milliseconds' }),
  ial: t.Optional(t.Union([ConsentIalSummary, t.Null()], { description: 'Present for combined consent and identity-assurance checks' })),
}, { title: 'ConsentDecisionEvent' })

export type ConsentDecisionEventType = Static<typeof ConsentDecisionEvent>

const DecisionCounts = t.Object({ permit: t.Number(), deny: t.Number() }, { title: 'ConsentDecisionCounts' })

export const ConsentAnalytics = t.Object({
  totalDecisions: t.Number({ description: 'Decisions in the last 24 h' }),
  permitRate: t.Number({ description: 'Permitted share (%)' }),
  denyRate: t.Number({ description: 'Denied share (%)' }),
  averageCheckDuration: t.Number({ description: 'Average check time in milliseconds' }),
  cacheHitRate: t.Number({ description: 'Share of decisions served from the cache (%)' }),
  decisionsByMode: t.Record(t.String(), t.Number(), { description: 'Decisions grouped by enforcement mode' }),
  decisionsByResourceType: t.Record(t.String(), DecisionCounts, { description: 'Permits and denies per resource type' }),
  topDeniedClients: t.Array(t.Object({ clientId: t.String(), denyCount: t.Number() }, { title: 'ConsentDeniedClient' }), { description: 'Clients denied most often' }),
  topDeniedPatients: t.Array(t.Object({ patientId: t.String(), denyCount: t.Number() }, { title: 'ConsentDeniedPatient' }), { description: 'Patients whose records were denied most often' }),
  hourlyStats: t.Array(t.Object({
    hour: t.String({ description: 'Hour bucket (ISO 8601)' }),
    permit: t.Number(),
    deny: t.Number(),
    total: t.Number(),
  }, { title: 'ConsentHourlyStats' }), { description: 'Hourly breakdown' }),
}, { title: 'ConsentAnalytics' })

export type ConsentAnalyticsType = Static<typeof ConsentAnalytics>

export const ConsentEventsResponse = buildEventsResponse({ title: 'ConsentEventsResponse', label: 'consent decision', event: ConsentDecisionEvent })

export const ConsentAnalyticsResponse = t.Composite([
  ConsentAnalytics,
  t.Object({ timestamp: t.String({ description: 'Response timestamp' }) }),
], { title: 'ConsentAnalyticsResponse' })

export const ConsentPatientAccessLogResponse = t.Object({
  events: t.Array(ConsentDecisionEvent, { description: 'Decisions on requests for this patient' }),
  total: t.Number({ description: 'Total events returned' }),
  patientId: t.String({ description: 'Patient the log is for' }),
  timestamp: t.String({ description: 'Response timestamp' }),
}, { title: 'ConsentPatientAccessLogResponse' })
