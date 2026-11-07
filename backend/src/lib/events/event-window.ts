// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export interface EventWindowQuery {
  limit?: string
  since?: string
}

export interface EventWindow {
  limit: number
  since?: Date
}

export interface EventWindowDefaults {
  defaultLimit: number
  maxLimit?: number
}

/** A limit that is not a positive integer takes the default; a since that is not a date is dropped. */
export function eventWindow(query: EventWindowQuery, { defaultLimit, maxLimit = Infinity }: EventWindowDefaults): EventWindow {
  const limit = Number.parseInt(query.limit ?? '', 10)
  const since = query.since ? new Date(query.since) : undefined
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, maxLimit) : defaultLimit,
    since: since && !Number.isNaN(since.getTime()) ? since : undefined,
  }
}
