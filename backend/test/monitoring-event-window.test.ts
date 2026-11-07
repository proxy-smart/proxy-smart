// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { applyEnv, overrideEnv } from './helpers/test-env'
import { signTestToken } from './helpers/jwt-test-keys'

const KC_BASE = 'http://localhost:8080'
const ISSUER = `${KC_BASE}/realms/proxy-smart`
const ADMIN_CLIENT_ID = 'admin-ui'

const savedEnv = overrideEnv({
  KEYCLOAK_BASE_URL: KC_BASE,
  KEYCLOAK_PUBLIC_URL: KC_BASE,
  KEYCLOAK_REALM: 'proxy-smart',
  KEYCLOAK_ADMIN_CLIENT_ID: ADMIN_CLIENT_ID,
  BASE_URL: 'http://localhost:8445',
})
const { adminRoutes } = await import('../src/routes/admin')
const { consentMetricsLogger } = await import('../src/lib/consent-metrics-logger')
const { eventWindow } = await import('../src/lib/events/event-window')

const CLIENT = `event-window-${Date.now()}`
const LOGGED = 105

const adminToken = () => signTestToken({
  iss: ISSUER,
  sub: 'admin-user',
  aud: ADMIN_CLIENT_ID,
  azp: ADMIN_CLIENT_ID,
  realmRoles: ['admin'],
  preferred_username: 'admin',
})

async function consentEvents(query: string): Promise<number> {
  const res = await new Elysia().use(adminRoutes).handle(new Request(
    `http://localhost/admin/monitoring/consent/events?clientId=${CLIENT}&${query}`,
    { headers: { authorization: `Bearer ${adminToken()}` } },
  ))
  expect(res.status).toBe(200)
  const body: { total: number } = await res.json()
  return body.total
}

beforeAll(async () => {
  for (let i = 0; i < LOGGED; i++) {
    await consentMetricsLogger.logDecision({
      decision: 'permit', enforced: true, mode: 'enforce', consentId: null, patientId: 'p-1',
      clientId: CLIENT, userId: 'u-1', username: 'dr.smith', resourceType: 'Observation',
      resourcePath: `Observation/${i}`, serverName: 'hapi', method: 'GET', reason: 'test', cached: false, checkDurationMs: 1,
    })
  }
})

afterAll(() => applyEnv(savedEnv))

describe('monitoring event queries', () => {
  it('ignores a since that is not a date instead of answering nothing', async () => {
    expect(await consentEvents('since=not-a-date')).toBe(100)
  })

  it('applies the default limit when the limit is not a number', async () => {
    expect(await consentEvents('limit=abc')).toBe(100)
  })

  it('applies the default limit when the limit is zero or negative', async () => {
    expect(await consentEvents('limit=-5')).toBe(100)
    expect(await consentEvents('limit=0')).toBe(100)
  })

  it('honours a valid limit and since', async () => {
    expect(await consentEvents('limit=7')).toBe(7)
    expect(await consentEvents(`since=${new Date(Date.now() + 60_000).toISOString()}`)).toBe(0)
  })
})

describe('eventWindow', () => {
  it('reads a positive limit, falls back to the default, and caps at the maximum', () => {
    expect(eventWindow({ limit: '5' }, { defaultLimit: 50 }).limit).toBe(5)
    expect(eventWindow({ limit: 'abc' }, { defaultLimit: 50 }).limit).toBe(50)
    expect(eventWindow({ limit: '-3' }, { defaultLimit: 50 }).limit).toBe(50)
    expect(eventWindow({ limit: '5000' }, { defaultLimit: 50, maxLimit: 1000 }).limit).toBe(1000)
  })

  it('drops a since that does not parse', () => {
    expect(eventWindow({ since: 'yesterday-ish' }, { defaultLimit: 50 }).since).toBeUndefined()
    expect(eventWindow({ since: '2026-01-01T00:00:00Z' }, { defaultLimit: 50 }).since?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})
