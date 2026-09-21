// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { type Static } from 'elysia'
import { buildAnalyticsResponse, buildEventsResponse, buildHourlyStats, buildKeycloakEvent } from './event-monitoring'

// ─── Email Event ─────────────────────────────────────────────────

export const EmailEvent = buildKeycloakEvent({
  title: 'EmailEvent',
  label: 'email',
  typeDescription: 'Keycloak event type (SEND_RESET_PASSWORD, SEND_VERIFY_EMAIL, …)',
  extra: {},
})

export type EmailEventType = Static<typeof EmailEvent>

// ─── Events list response ────────────────────────────────────────

export const EmailEventsResponse = buildEventsResponse({
  title: 'EmailEventsResponse',
  label: 'email',
  event: EmailEvent,
})

export type EmailEventsResponseType = Static<typeof EmailEventsResponse>

// ─── Analytics response ──────────────────────────────────────────

export const EmailHourlyStats = buildHourlyStats('EmailHourlyStats')

export const EmailAnalyticsResponse = buildAnalyticsResponse({
  title: 'EmailAnalyticsResponse',
  label: 'email',
  event: EmailEvent,
  hourlyStats: EmailHourlyStats,
  extra: {},
})

export type EmailAnalyticsResponseType = Static<typeof EmailAnalyticsResponse>
