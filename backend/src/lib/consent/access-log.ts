// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import { eventWindow } from '../events/event-window'
import type { ConsentDecisionEvent } from '../consent-metrics-logger'
import type { PatientAccessEntryType } from '@/schemas/consent'
import { keycloakUserLabel, labelsFor, type UserLabelLookup } from '../user-labels'

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
  return {
    ...eventWindow(query, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT }),
    decision: unlessAll(query.decision),
    resourceType: unlessAll(query.resourceType),
  }
}

/** Decisions with who made each request resolved now; the log itself keeps the user id only. */
export async function withRequesterNames(
  events: readonly ConsentDecisionEvent[],
  lookup: UserLabelLookup = keycloakUserLabel,
): Promise<ConsentDecisionEvent[]> {
  const labels = await labelsFor(events.map(event => event.userId), lookup)
  return events.map(event => ({ ...event, username: (event.userId && labels.get(event.userId)) || null }))
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
