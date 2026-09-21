// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import type { TProperties, TSchema } from '@sinclair/typebox'

// `title` drives the generated client model name, `label` the human-readable descriptions.
type MonitoringSchema = { title: string, label: string }

// ─── Keycloak event ──────────────────────────────────────────────

// `extra` sits between clientId and ipAddress to keep the emitted property order stable.
export const buildKeycloakEvent = <Extra extends TProperties>(
  options: MonitoringSchema & { typeDescription: string, extra: Extra },
) => t.Object({
  id: t.String({ description: 'Unique event ID (from Keycloak or generated)' }),
  timestamp: t.String({ description: 'ISO 8601 timestamp' }),
  type: t.String({ description: options.typeDescription }),
  userId: t.Optional(t.String({ description: 'Keycloak user ID' })),
  clientId: t.Optional(t.String({ description: 'OAuth client that triggered the event' })),
  ...options.extra,
  ipAddress: t.Optional(t.String({ description: 'IP address of the request' })),
  error: t.Optional(t.String({ description: 'Error message if the event failed' })),
  success: t.Boolean({ description: `Whether the ${options.label} action succeeded` }),
  details: t.Optional(t.Record(t.String(), t.String(), { description: 'Additional event details from Keycloak' })),
}, { title: options.title })

// ─── Events list response ────────────────────────────────────────

export const buildEventsResponse = <Event extends TSchema>(
  options: MonitoringSchema & { event: Event },
) => t.Object({
  events: t.Array(options.event, { description: `Array of ${options.label} events` }),
  total: t.Number({ description: 'Total events returned' }),
  timestamp: t.String({ description: 'Response timestamp' }),
}, { title: options.title })

// ─── Hourly stats ────────────────────────────────────────────────

export const buildHourlyStats = (title: string) => t.Object({
  hour: t.String({ description: 'Hour bucket (ISO 8601)' }),
  success: t.Number({ description: 'Successful events' }),
  failure: t.Number({ description: 'Failed events' }),
  total: t.Number({ description: 'Total events' }),
}, { title })

// ─── Analytics response ──────────────────────────────────────────

// `extra` sits between hourlyStats and timestamp to keep the emitted property order stable.
export const buildAnalyticsResponse = <Event extends TSchema, Hourly extends TSchema, Extra extends TProperties>(
  options: MonitoringSchema & { event: Event, hourlyStats: Hourly, extra: Extra },
) => t.Object({
  totalEvents: t.Number({ description: `Total ${options.label} events in the last 24 h` }),
  successRate: t.Number({ description: 'Success rate (%)' }),
  eventsByType: t.Record(t.String(), t.Number(), { description: 'Events grouped by type' }),
  recentErrors: t.Array(options.event, { description: 'Most recent failed events' }),
  hourlyStats: t.Array(options.hourlyStats, { description: 'Hourly breakdown' }),
  ...options.extra,
  timestamp: t.String({ description: 'Response timestamp' }),
}, { title: options.title })
