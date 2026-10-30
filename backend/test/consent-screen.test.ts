// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { fakeFetch } from './helpers/fake-fetch'
import { screenUnconsentedRecords, screensConsent, type ConsentScreenContext } from '../src/lib/consent/consent-screen'
import { consentCache } from '../src/lib/consent/consent-cache'
import { executeFhirRequest, type FhirTarget } from '../src/lib/fhir-request-pipeline'

const UPSTREAM = 'http://fhir.test/fhir'
const PROXY_BASE = 'http://proxy.test/proxy-smart-backend/hapi/R4'
const consentQueries: string[] = []
const originalFetch = globalThis.fetch

function permitFor(client: string) {
  return {
    resourceType: 'Consent',
    id: 'c1',
    status: 'active',
    provision: { type: 'permit', actor: [{ role: { coding: [{ code: 'GRANTEE' }] }, reference: { reference: `Organization/${client}` } }] },
  }
}

const observation = (patient: string, id = `obs-${patient}`) => ({ resourceType: 'Observation', id, subject: { reference: `Patient/${patient}` } })

function ctx(overrides: Partial<ConsentScreenContext> = {}): ConsentScreenContext {
  return {
    tokenPayload: { sub: 'dr-1', azp: 'viewer', scope: 'openid user/Observation.rs', fhirUser: 'Practitioner/dr-1' },
    serverName: 'hapi',
    serverUrl: UPSTREAM,
    referenceBase: PROXY_BASE,
    authHeader: 'Bearer t',
    resourcePath: 'Observation',
    method: 'GET',
    ...overrides,
  }
}

describe('screenUnconsentedRecords', () => {
  beforeEach(() => {
    process.env.CONSENT_ENABLED = 'true'
    process.env.CONSENT_MODE = 'enforce'
    consentCache.clear()
    consentQueries.length = 0
    globalThis.fetch = fakeFetch((url) => {
      consentQueries.push(url)
      const patient = new URL(url).searchParams.get('patient')
      const entry = patient === 'Patient/consented' ? [{ resource: permitFor('viewer') }] : []
      return new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry }), {
        status: 200, headers: { 'content-type': 'application/fhir+json' },
      })
    })
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.CONSENT_ENABLED
    delete process.env.CONSENT_MODE
  })

  it('takes records of a patient who has not consented out of a search answer', async () => {
    const answer = {
      status: 200,
      body: { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: observation('consented') }, { resource: observation('other') }] },
    }
    const screened = await screenUnconsentedRecords(ctx(), answer)
    const body = screened.body
    if (typeof body !== 'object' || body === null || !('entry' in body) || !Array.isArray(body.entry)) throw new Error('not a bundle')
    expect(body.entry.map((e: { resource: { id: string } }) => e.resource.id)).toEqual(['obs-consented'])
  })

  it('asks once per patient however many records they have', async () => {
    const answer = {
      status: 200,
      body: { resourceType: 'Bundle', entry: [{ resource: observation('other', 'a') }, { resource: observation('other', 'b') }] },
    }
    await screenUnconsentedRecords(ctx(), answer)
    expect(consentQueries).toHaveLength(1)
  })

  it('refuses a single record of a patient who has not consented', async () => {
    const screened = await screenUnconsentedRecords(ctx({ resourcePath: 'Observation/obs-other' }), { status: 200, body: observation('other') })
    expect(screened.status).toBe(403)
  })

  it('recognises a patient referenced through the proxy base URL', async () => {
    const record = { resourceType: 'Observation', id: 'x', subject: { reference: `${PROXY_BASE}/Patient/other` } }
    expect((await screenUnconsentedRecords(ctx(), { status: 200, body: record })).status).toBe(403)
  })

  it('leaves the patient\'s own record alone', async () => {
    const own = ctx({ tokenPayload: { sub: 'p', azp: 'viewer', scope: 'openid user/Observation.rs', fhirUser: 'Patient/other' } })
    expect((await screenUnconsentedRecords(own, { status: 200, body: observation('other') })).status).toBe(200)
  })

  it('leaves answers alone for a token confined to one patient', async () => {
    const patientToken = ctx({ tokenPayload: { sub: 'p', azp: 'viewer', scope: 'openid patient/Observation.rs', patient: 'other' } })
    expect((await screenUnconsentedRecords(patientToken, { status: 200, body: observation('other') })).status).toBe(200)
    expect(consentQueries).toHaveLength(0)
  })

  it('leaves the answer to a write alone', async () => {
    const write = ctx({ method: 'POST' })
    expect((await screenUnconsentedRecords(write, { status: 201, body: observation('other') })).status).toBe(201)
  })

  it('only reports in audit-only mode', async () => {
    process.env.CONSENT_MODE = 'audit-only'
    expect((await screenUnconsentedRecords(ctx(), { status: 200, body: observation('other') })).status).toBe(200)
  })

  it('leaves an exempt client alone', async () => {
    process.env.CONSENT_EXEMPT_CLIENTS = 'viewer'
    try {
      expect((await screenUnconsentedRecords(ctx(), { status: 200, body: observation('other') })).status).toBe(200)
    } finally {
      delete process.env.CONSENT_EXEMPT_CLIENTS
    }
  })
})

describe('screensConsent', () => {
  it('applies to user, system and agent grants, not to patient grants', () => {
    expect(screensConsent({ scope: 'user/*.rs' })).toBe(true)
    expect(screensConsent({ scope: 'system/Observation.rs' })).toBe(true)
    expect(screensConsent({ scope: 'agent/*.rs' })).toBe(true)
    expect(screensConsent({ scope: 'openid patient/*.rs' })).toBe(false)
  })
})

describe('consent screening through the pipeline', () => {
  const target: FhirTarget = {
    serverInfo: { name: 'hapi', url: UPSTREAM, identifier: 'consent-screen', lastUpdated: 0, metadata: { fhirVersion: '4.0.1', supported: true } },
    serverName: 'hapi',
    fhirVersion: 'R4',
    upstreamFetch: async (url: string) => new Response(JSON.stringify(
      url.includes('/Observation') ? { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: observation('consented') }, { resource: observation('other') }] } : {},
    ), { status: 200, headers: { 'content-type': 'application/fhir+json' } }),
  }
  const practitioner = { tokenPayload: { sub: 'viewer', scope: 'openid user/Observation.rs', fhirUser: 'Practitioner/dr-1', aud: UPSTREAM }, authHeader: 'Bearer t' }

  beforeEach(() => {
    process.env.CONSENT_ENABLED = 'true'
    process.env.CONSENT_MODE = 'enforce'
    consentCache.clear()
    globalThis.fetch = fakeFetch((url) => {
      const patient = new URL(url).searchParams.get('patient')
      const entry = patient === 'Patient/consented' ? [{ resource: permitFor('viewer') }] : []
      return new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry }), { status: 200, headers: { 'content-type': 'application/fhir+json' } })
    })
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.CONSENT_ENABLED
    delete process.env.CONSENT_MODE
  })

  it.serial('returns a practitioner search only for patients who consented', async () => {
    const result = await executeFhirRequest(target, practitioner, {
      method: 'GET', resourcePath: 'Observation', queryString: '?patient=Patient/other', headers: new Headers(),
    })
    expect(result.status).toBe(200)
    const body = result.body
    if (typeof body !== 'object' || body === null || !('entry' in body) || !Array.isArray(body.entry)) throw new Error('not a bundle')
    expect(body.entry.map((e: { resource: { id: string } }) => e.resource.id)).toEqual(['obs-consented'])
  })
})
