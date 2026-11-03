// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it, spyOn } from 'bun:test'
import * as addedBy from '../src/lib/consent/added-by-requester'
import { addedByProvenance } from '../src/lib/fhir-authorship'
import { authoredRecords, authorRequest, isAuthoredExport, isRetraction } from '../src/lib/fhir-author-access'
import type { AccessControlContext } from '../src/lib/smart-access-control'

const BASE = 'http://fhir.test/fhir'
const DOCTOR = { fhirUser: 'Person/dr', azp: 'viewer', scope: 'user/*.cruds' }

type Res = Record<string, unknown>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/fhir+json' } })
}

function observation(extra: Res = {}): Res {
  return {
    resourceType: 'Observation', id: 'o1', meta: { versionId: '2', lastUpdated: '2026-11-01T00:00:00Z' },
    status: 'final', code: { text: 'Penicillin allergy' }, subject: { reference: 'Patient/p1' }, ...extra,
  }
}

function ctx(method: string, resourcePath: string, upstreamFetch: AccessControlContext['upstreamFetch'], tokenPayload: Res = DOCTOR): AccessControlContext {
  return { tokenPayload, resourcePath, method, serverUrl: BASE, serverId: 'hapi', serverName: 'hapi', authHeader: 'Bearer t', upstreamFetch }
}

describe('isRetraction', () => {
  it('accepts a record marked entered-in-error, by status or verification status', () => {
    expect(isRetraction(observation(), observation({ status: 'entered-in-error' }))).toBe(true)
    const condition = { resourceType: 'Condition', id: 'c1', verificationStatus: { coding: [{ code: 'confirmed' }] }, subject: { reference: 'Patient/p1' } }
    expect(isRetraction(condition, { ...condition, verificationStatus: { coding: [{ code: 'entered-in-error' }] } })).toBe(true)
  })

  it('accepts a note saying why, and a new version stamp', () => {
    const proposed = observation({ status: 'entered-in-error', meta: { versionId: '3' }, note: [{ text: 'Wrong patient' }] })
    expect(isRetraction(observation(), proposed)).toBe(true)
  })

  it('refuses any other change made along with it', () => {
    expect(isRetraction(observation(), observation({ status: 'entered-in-error', code: { text: 'Something else' } }))).toBe(false)
    expect(isRetraction(observation({ note: [{ text: 'a' }] }), observation({ status: 'entered-in-error', note: [{ text: 'b' }] }))).toBe(false)
    expect(isRetraction(observation(), observation({ status: 'entered-in-error', meta: { security: [{ code: 'R' }] } }))).toBe(false)
    expect(isRetraction(observation(), observation({ status: 'amended' }))).toBe(false)
    expect(isRetraction(observation({ status: 'entered-in-error' }), observation({ status: 'entered-in-error' }))).toBe(false)
    expect(isRetraction(observation(), observation({ id: 'o2', status: 'entered-in-error' }))).toBe(false)
  })
})

describe('authorRequest', () => {
  const stored = (resource: Res): AccessControlContext['upstreamFetch'] => async () => json({ resourceType: 'Bundle', entry: [{ resource }] })

  it('recognises the export at the server base only', async () => {
    expect(isAuthoredExport('GET', '$authored')).toBe(true)
    expect(isAuthoredExport('GET', 'Observation/$authored')).toBe(false)
    expect(isAuthoredExport('POST', '$authored')).toBe(false)
    expect(await authorRequest(ctx('GET', '$authored', stored({})), undefined)).toEqual({ kind: 'authored' })
    expect(await authorRequest(ctx('GET', '$authored', stored({}), { scope: 'system/*.rs' }), undefined)).toBeNull()
  })

  it('lets the clinician who added a record mark it entered-in-error', async () => {
    const adder = spyOn(addedBy, 'addedByRequester').mockImplementation(async () => true)
    const body = JSON.stringify(observation({ status: 'entered-in-error' }))
    expect(await authorRequest(ctx('PUT', 'Observation/o1', stored(observation())), body)).toEqual({ kind: 'retraction', reference: 'Observation/o1', patientId: 'p1' })
    adder.mockRestore()
  })

  it('leaves it to consent when someone else added the record, or it is any other change', async () => {
    const adder = spyOn(addedBy, 'addedByRequester').mockImplementation(async () => false)
    expect(await authorRequest(ctx('PUT', 'Observation/o1', stored(observation())), JSON.stringify(observation({ status: 'entered-in-error' })))).toBeNull()
    adder.mockImplementation(async () => true)
    expect(await authorRequest(ctx('PUT', 'Observation/o1', stored(observation())), JSON.stringify(observation({ status: 'amended' })))).toBeNull()
    expect(await authorRequest(ctx('PATCH', 'Observation/o1', stored(observation())), JSON.stringify(observation({ status: 'entered-in-error' })))).toBeNull()
    adder.mockRestore()
  })
})

describe('authoredRecords', () => {
  async function server(): Promise<{ fetch: AccessControlContext['upstreamFetch']; searched: string[] }> {
    const mine = { ...await addedByProvenance({ type: 'Observation', id: 'o1', version: '1', chart: 'Patient/p1' }, 'Person/dr'), id: 'prov-1' }
    const erased = { ...await addedByProvenance({ type: 'Observation', id: 'gone', version: '1', chart: 'Patient/p2' }, 'Person/dr'), id: 'prov-2' }
    const forged = { ...await addedByProvenance({ type: 'Observation', id: 'o9', version: '1', chart: 'Patient/p3' }, 'Person/someone-else'), id: 'prov-3', agent: [{ who: { reference: 'Person/dr' } }] }
    const searched: string[] = []
    const fetch: AccessControlContext['upstreamFetch'] = async (url, init) => {
      if (init?.method === 'POST') {
        const batch: unknown = JSON.parse(String(init.body))
        const urls = typeof batch === 'object' && batch !== null && 'entry' in batch && Array.isArray(batch.entry)
          ? batch.entry.map((e: { request: { url: string } }) => e.request.url) : []
        return json({
          resourceType: 'Bundle', type: 'batch-response',
          entry: urls.map((u: string) => u.startsWith('Observation/o1/')
            ? { resource: observation({ id: 'o1', meta: { versionId: '1' } }), response: { status: '200 OK' } }
            : { response: { status: '410 Gone' } }),
        })
      }
      searched.push(url)
      return json({ resourceType: 'Bundle', entry: [mine, erased, forged].map((resource) => ({ resource })) })
    }
    return { fetch, searched }
  }

  it('returns each record at the version the user added it, with its signed Provenance', async () => {
    const { fetch, searched } = await server()
    const result = await authoredRecords(ctx('GET', '$authored', fetch))
    expect(result.status).toBe(200)
    expect(searched[0]).toContain('Provenance?agent=Person%2Fdr')
    const entries = Array.isArray(result.body.entry) ? result.body.entry : []
    expect(entries.map((e: { fullUrl: string }) => e.fullUrl)).toEqual([`${BASE}/Observation/o1/_history/1`, `${BASE}/Provenance/prov-1`])
  })

  it('answers with an OperationOutcome when the server cannot be read', async () => {
    const result = await authoredRecords(ctx('GET', '$authored', async () => new Response('down', { status: 500 })))
    expect(result.status).toBe(502)
    expect(result.body.resourceType).toBe('OperationOutcome')
  })
})
