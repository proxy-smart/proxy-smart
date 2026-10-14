// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { createEventFilter, toClientFilters } from '../src/routes/websocket-factory'

type Event = { type: string; timestamp: string }

const filterEvents = createEventFilter<Event>(event => event.type, event => event.timestamp)

describe('toClientFilters', () => {
  it('parses a timeRange into Dates so time filtering matches events inside it', () => {
    const filters = toClientFilters({
      timeRange: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z' },
    })
    expect(filters?.timeRange?.start).toBeInstanceOf(Date)

    const events: Event[] = [
      { type: 'token', timestamp: '2026-01-01T12:00:00.000Z' },
      { type: 'token', timestamp: '2026-02-01T12:00:00.000Z' },
    ]
    expect(filterEvents(events, filters ?? {})).toEqual([events[0]])
  })

  it('leaves keys the update did not name absent, so merging keeps earlier filters', () => {
    expect(toClientFilters({ eventTypes: ['token'] })).toEqual({ eventTypes: ['token'] })
  })

  it('rejects payloads that do not match the filter schema', () => {
    expect(toClientFilters({ logLevel: 'debug' })).toBeUndefined()
    expect(toClientFilters('events')).toBeUndefined()
  })
})
