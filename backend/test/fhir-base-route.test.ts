// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { fakeFetch } from './helpers/fake-fetch'
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

const UPSTREAM = 'http://upstream.test/fhir'
const upstreamCalls: string[] = []

globalThis.fetch = fakeFetch(async (url: string) => {
    upstreamCalls.push(url)
    const link = [{ relation: 'next', url: `${UPSTREAM}?_getpages=abc&_getpagesoffset=20&_count=20` }]
    return new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link, entry: [] }), {
      status: 200, headers: { 'content-type': 'application/fhir+json' },
    })
  })

mock.module('../src/lib/fhir-server-store', () => ({
  fhirServerStore: { getIsInitialized: () => true },
  getServerByName: async () => UPSTREAM,
  getServerInfoByName: async () => ({
    name: 'hapi', url: UPSTREAM, identifier: 'hapi', lastUpdated: 0, metadata: { fhirVersion: '4.0.1', supported: true },
  }),
  fhirResourceUrlFor: (server: { identifier: string; metadata: { fhirVersion: string } }) =>
    `http://localhost/proxy-smart-backend/${server.identifier}/${server.metadata.fhirVersion}`,
}))

mock.module('../src/lib/auth', () => ({
  validateAdminToken: async () => { throw new Error('not an admin token') },
  validateToken: async (token: string) => {
    if (token === 'other-server-token') return { sub: 'u1', scope: 'system/*.rs', aud: 'http://localhost/proxy-smart-backend/other/R4' }
    if (token !== 'patient-token') throw new Error('invalid token')
    return { sub: 'u1', scope: 'openid patient/Observation.rs', patient: 'p1', aud: `${config.baseUrl}/${config.name}/hapi/R4` }
  },
}))

const { config } = await import('../src/config')
const { fhirRoutes } = await import('../src/routes/fhir')
const { pageCursorCache } = await import('../src/lib/cache/page-cursor-cache')

const BASE = `http://localhost/${config.name}/hapi/R4`

function get(query: string, token?: string): Promise<Response> {
  return fhirRoutes.handle(new Request(`${BASE}${query}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}))
}

describe('GET at the FHIR server base', () => {
  beforeEach(() => { upstreamCalls.length = 0 })

  it('does not run a search across all types for an anonymous caller', async () => {
    const res = await get('?_type=Patient')
    expect(res.status).toBe(401)
    expect(upstreamCalls.filter((u) => u.includes('_type'))).toEqual([])
  })

  it('needs an unconstrained wildcard scope for a search across all types', async () => {
    const res = await get('?_type=Patient', 'patient-token')
    expect(res.status).toBe(403)
    expect(upstreamCalls.filter((u) => u.includes('_type'))).toEqual([])
  })

  it.serial('follows a paging link only from a search the caller ran', async () => {
    process.env.CONSENT_ENABLED = 'false'
    pageCursorCache.clear()
    expect((await get('?_getpages=abc&_getpagesoffset=20&_count=20')).status).toBe(401)
    expect((await get('?_getpages=abc&_getpagesoffset=20&_count=20', 'patient-token')).status).toBe(403)
    expect(upstreamCalls).toEqual([])

    expect((await get('/Observation?code=x', 'patient-token')).status).toBe(200)
    upstreamCalls.length = 0
    const res = await get('?_getpages=abc&_getpagesoffset=20&_count=20', 'patient-token')
    expect(res.status).toBe(200)
    expect(upstreamCalls).toEqual([`${UPSTREAM}?_getpages=abc&_getpagesoffset=20&_count=20`])
    delete process.env.CONSENT_ENABLED
  })
})

describe('POST at the FHIR server base', () => {
  beforeEach(() => { upstreamCalls.length = 0; process.env.CONSENT_ENABLED = 'false' })
  afterEach(() => { delete process.env.CONSENT_ENABLED })

  it('answers a batch entry by entry instead of refusing or forwarding it whole', async () => {
    const batch = {
      resourceType: 'Bundle',
      type: 'batch',
      entry: [{ request: { method: 'GET', url: 'Observation?code=x' } }, { request: { method: 'GET', url: 'Condition' } }],
    }
    const res = await fhirRoutes.handle(new Request(BASE, {
      method: 'POST',
      headers: { authorization: 'Bearer patient-token', 'content-type': 'application/fhir+json' },
      body: JSON.stringify(batch),
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe('batch-response')
    expect(body.entry.map((e: { response: { status: string } }) => e.response.status)).toEqual(['200 OK', '403 Forbidden'])
    expect(upstreamCalls.some((u) => u.startsWith(`${UPSTREAM}/Observation?code=x`))).toBe(true)
    expect(upstreamCalls.some((u) => u.includes('/Condition'))).toBe(false)
    expect(upstreamCalls.some((u) => u === UPSTREAM || u === `${UPSTREAM}/`)).toBe(false)
  })
})

describe('a token authorized for another FHIR server', () => {
  beforeEach(() => { upstreamCalls.length = 0 })
  afterEach(() => { delete process.env.FHIR_AUDIENCE_ENFORCEMENT; delete process.env.CONSENT_ENABLED })

  it.serial('is answered with an invalid_token challenge when FHIR_AUDIENCE_ENFORCEMENT=enforce', async () => {
    process.env.FHIR_AUDIENCE_ENFORCEMENT = 'enforce'
    for (const query of ['?_type=Patient', '?_getpages=abc']) {
      const res = await get(query, 'other-server-token')
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    }
    expect(upstreamCalls).toEqual([])
  })

  it.serial('still reaches the server in audit-only mode', async () => {
    process.env.FHIR_AUDIENCE_ENFORCEMENT = 'audit-only'
    process.env.CONSENT_ENABLED = 'false'
    pageCursorCache.clear()
    expect((await get('/Observation?code=x', 'other-server-token')).status).toBe(200)
    const res = await get('?_getpages=abc&_getpagesoffset=20&_count=20', 'other-server-token')
    expect(res.status).toBe(200)
  })
})
