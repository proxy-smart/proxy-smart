// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { signTestToken } from './helpers/jwt-test-keys'

const KC_BASE = 'http://localhost:8080'
const ISSUER = `${KC_BASE}/realms/proxy-smart`

const ENV: Record<string, string> = {
  KEYCLOAK_BASE_URL: KC_BASE,
  KEYCLOAK_PUBLIC_URL: KC_BASE,
  KEYCLOAK_REALM: 'proxy-smart',
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-ui',
  BASE_URL: 'http://localhost:8445',
}
const SNAPSHOT: Record<string, string | undefined> = {}

for (const [key, value] of Object.entries(ENV)) {
  SNAPSHOT[key] = process.env[key]
  process.env[key] = value
}
const { config } = await import('../src/config')
const { consentAccessLogRoutes } = await import('../src/routes/api/consent-access-log')
const { consentMetricsLogger } = await import('../src/lib/consent-metrics-logger')
const { accessLogFilters } = await import('../src/lib/consent/access-log')

const PATIENT = `access-log-${Date.now()}-a`
const OTHER = `access-log-${Date.now()}-b`

const FHIR_AUDIENCE = `${config.baseUrl}/${config.name}/hapi-fhir-server/R4`
const tokenWith = (extra: Record<string, unknown>) => signTestToken({ iss: ISSUER, aud: FHIR_AUDIENCE, azp: 'consent-app', extra })

function accessLog(token: string | null, query = '') {
  return new Elysia().use(consentAccessLogRoutes).handle(new Request(`http://localhost/consent/monitoring/access-log${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }))
}

async function decision(patientId: string, decision: 'permit' | 'deny', resourceType: string) {
  await consentMetricsLogger.logDecision({
    decision, enforced: true, mode: 'enforce', consentId: null, patientId,
    clientId: 'practice-app', userId: 'u-1', username: 'dr.smith', resourceType,
    resourcePath: `${resourceType}/1`, serverName: 'hapi', method: 'GET', reason: 'test', cached: false, checkDurationMs: 1,
  })
}

beforeAll(async () => {
  await decision(PATIENT, 'permit', 'Observation')
  await decision(PATIENT, 'deny', 'Condition')
  await decision(OTHER, 'permit', 'Observation')
})

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (SNAPSHOT[key] === undefined) delete process.env[key]
    else process.env[key] = SNAPSHOT[key]
  }
})

describe('GET /consent/monitoring/access-log', () => {
  it('answers 401 without a token', async () => {
    expect((await accessLog(null)).status).toBe(401)
  })

  it('returns nothing to a token that names no patient', async () => {
    const res = await accessLog(tokenWith({ fhirUser: 'Practitioner/7' }))
    expect(res.status).toBe(400)
    expect(await res.json()).not.toHaveProperty('events')
  })

  it('returns the token patient\'s events and ignores a patient named in the query', async () => {
    const res = await accessLog(tokenWith({ patient: PATIENT }), `?patientId=${OTHER}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toHaveLength(2)
    expect(body.events.every((e: { resourceType: string }) => ['Observation', 'Condition'].includes(e.resourceType))).toBe(true)
  })

  it('carries only who, what, when and the decision', async () => {
    const body = await (await accessLog(tokenWith({ patient: PATIENT }))).json()
    expect(Object.keys(body.events[0]).sort()).toEqual(['clientId', 'decision', 'id', 'method', 'reason', 'resourceType', 'timestamp', 'username'])
  })

  it('filters by decision', async () => {
    const body = await (await accessLog(tokenWith({ patient: PATIENT }), '?decision=deny')).json()
    expect(body.events.map((e: { resourceType: string }) => e.resourceType)).toEqual(['Condition'])
  })
})

describe('accessLogFilters', () => {
  it('reads a numeric limit, caps it, and drops one that is not a number', () => {
    expect(accessLogFilters({ limit: '5' }).limit).toBe(5)
    expect(accessLogFilters({ limit: '100000' }).limit).toBe(1000)
    expect(accessLogFilters({ limit: 'abc' }).limit).toBe(200)
  })

  it('treats "all" as no filter and drops an unparseable since', () => {
    const filters = accessLogFilters({ decision: 'all', resourceType: 'all', since: 'not-a-date' })
    expect(filters.decision).toBeUndefined()
    expect(filters.resourceType).toBeUndefined()
    expect(filters.since).toBeUndefined()
  })
})
