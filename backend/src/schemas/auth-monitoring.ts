// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'
import { buildAnalyticsResponse, buildEventsResponse, buildHourlyStats, buildKeycloakEvent } from './event-monitoring'

// ─── Auth Event ──────────────────────────────────────────────────

export const AuthEvent = buildKeycloakEvent({
  title: 'AuthEvent',
  label: 'auth',
  typeDescription: 'Keycloak event type (LOGIN, LOGOUT, REGISTER, CODE_TO_TOKEN, …)',
  extra: {
    sessionId: t.Optional(t.String({ description: 'Keycloak session ID' })),
  },
})

export type AuthEventType = Static<typeof AuthEvent>

// ─── Events list response ────────────────────────────────────────

export const AuthEventsResponse = buildEventsResponse({
  title: 'AuthEventsResponse',
  label: 'auth',
  event: AuthEvent,
})

export type AuthEventsResponseType = Static<typeof AuthEventsResponse>

// ─── Top clients ─────────────────────────────────────────────────

export const AuthTopClient = t.Object({
  clientId: t.String({ description: 'OAuth client ID' }),
  count: t.Number({ description: 'Number of events for this client' }),
}, { title: 'AuthTopClient' })

// ─── Analytics response ──────────────────────────────────────────

export const AuthHourlyStats = buildHourlyStats('AuthHourlyStats')

export const AuthAnalyticsResponse = buildAnalyticsResponse({
  title: 'AuthAnalyticsResponse',
  label: 'auth',
  event: AuthEvent,
  hourlyStats: AuthHourlyStats,
  extra: {
    topClients: t.Array(AuthTopClient, { description: 'Top 10 clients by event count' }),
  },
})

export type AuthAnalyticsResponseType = Static<typeof AuthAnalyticsResponse>
