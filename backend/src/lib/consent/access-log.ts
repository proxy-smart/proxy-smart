// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import type { ConsentDecisionEvent } from '../consent-metrics-logger'
import type { PatientAccessEntryType } from '@/schemas/consent'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

export const accessLogQueryFields = {
  limit: t.Optional(t.String()),
  decision: t.Optional(t.String()),
  resourceType: t.Optional(t.String()),
  since: t.Optional(t.String()),
}

export interface AccessLogQuery {
  limit?: string
  decision?: string
  resourceType?: string
  since?: string
}

export interface AccessLogFilters {
  limit: number
  decision?: string
  resourceType?: string
  since?: Date
}

const unlessAll = (value?: string): string | undefined => (value && value !== 'all' ? value : undefined)

export function accessLogFilters(query: AccessLogQuery): AccessLogFilters {
  const limit = Number.parseInt(query.limit ?? '', 10)
  const since = query.since ? new Date(query.since) : undefined
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
    decision: unlessAll(query.decision),
    resourceType: unlessAll(query.resourceType),
    since: since && !Number.isNaN(since.getTime()) ? since : undefined,
  }
}

export function patientAccessEntry(event: ConsentDecisionEvent): PatientAccessEntryType {
  return {
    id: event.id,
    timestamp: event.timestamp,
    decision: event.decision,
    clientId: event.clientId,
    username: event.username,
    resourceType: event.resourceType,
    method: event.method,
    reason: event.reason,
  }
}
