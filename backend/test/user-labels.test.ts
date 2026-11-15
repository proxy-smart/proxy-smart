// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { labelsFor, withoutPersonalDetails, type UserLabelLookup } from '../src/lib/user-labels'
import { withRequesterNames } from '../src/lib/consent/access-log'
import type { ConsentDecisionEvent } from '../src/lib/consent-metrics-logger'

function recordingLookup(names: Record<string, string>): { lookup: UserLabelLookup; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    lookup: async (userId) => {
      asked.push(userId)
      return names[userId] ?? null
    },
  }
}

const decision = (userId: string | null): ConsentDecisionEvent => ({
  id: `consent-${userId ?? 'none'}`,
  timestamp: new Date().toISOString(),
  decision: 'permit',
  enforced: true,
  mode: 'enforce',
  consentId: null,
  patientId: 'p-1',
  clientId: 'practice-app',
  userId,
  username: null,
  resourceType: 'Observation',
  resourcePath: 'Observation',
  serverName: 'hapi',
  method: 'GET',
  reason: 'consented',
  cached: false,
  checkDurationMs: 1,
})

describe('user labels', () => {
  it('asks once per distinct user and skips ids that name nobody', async () => {
    const { lookup, asked } = recordingLookup({ 'u-1': 'dr.smith' })
    const labels = await labelsFor(['u-1', 'u-1', 'unknown', null, undefined, 'u-2'], lookup)

    expect(asked).toEqual(['u-1', 'u-2'])
    expect([...labels]).toEqual([['u-1', 'dr.smith']])
  })

  it('drops the Keycloak event details that name a person and keeps the rest', () => {
    const event: { id: string; userId: string; details: Record<string, string> } = { id: 'e', userId: 'u-1', details: { username: 'a@b.test', email: 'a@b.test', identity_provider_identity: 'a@b.test', redirect_uri: 'https://app.test/cb' } }
    expect(withoutPersonalDetails(event)).toEqual({ id: 'e', userId: 'u-1', details: { redirect_uri: 'https://app.test/cb' } })
  })

  it('leaves an event without details as it is', () => {
    const event = { id: 'e', userId: 'u-1' }
    expect(withoutPersonalDetails(event)).toBe(event)
  })

  it('names the requester of each access-log entry from its user id', async () => {
    const { lookup } = recordingLookup({ 'u-1': 'dr.smith' })
    const shown = await withRequesterNames([decision('u-1'), decision('u-2'), decision(null)], lookup)
    expect(shown.map((event) => event.username)).toEqual(['dr.smith', null, null])
  })
})

const { adminAuditLogger } = await import('../src/lib/admin-audit-logger')

describe('admin audit actors', () => {
  const failure = {
    id: 'audit-1', timestamp: new Date().toISOString(), actor: { sub: 'u-1' }, method: 'DELETE', path: '/admin/roles/x',
    action: 'delete' as const, resource: 'roles', statusCode: 500, success: false, durationMs: 3,
  }

  it('shows who an actor is without the event having kept it', async () => {
    const { lookup } = recordingLookup({ 'u-1': 'admin.jane' })
    const [shown] = await adminAuditLogger.present([failure], lookup)
    expect(shown?.actor).toEqual({ sub: 'u-1', username: 'admin.jane' })
  })

  it('names the top actors and recent failures of the analytics, falling back to the id', async () => {
    const { lookup } = recordingLookup({ 'u-1': 'admin.jane' })
    const analytics = await adminAuditLogger.presentAnalytics({
      totalActions: 2, successRate: 50, actionsByType: {}, actionsByResource: {}, hourlyStats: [],
      topActors: [{ username: 'u-1', count: 1 }, { username: 'u-gone', count: 1 }],
      recentFailures: [failure],
    }, lookup)
    expect(analytics.topActors.map((actor) => actor.username)).toEqual(['admin.jane', 'u-gone'])
    expect(analytics.recentFailures[0]?.actor.username).toBe('admin.jane')
  })
})
