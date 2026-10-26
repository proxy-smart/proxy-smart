// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { addedByProvenance, ADDED_BY_POLICY } from '../src/lib/fhir-authorship'
import { eraseRecord, type ErasureRequest } from '../src/lib/fhir-erasure'

const BASE = 'http://fhir.test/fhir'
const PATIENT = { fhirUser: 'Patient/p1', patient: 'p1', scope: 'patient/Condition.cruds' }

type Res = Record<string, unknown>

interface FakeServer {
  history: Res[]
  provenance: Res[]
  referrers: Res[]
  calls: string[]
  fail?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/fhir+json' } })
}

function bundle(entries: Res[]): Res {
  return { resourceType: 'Bundle', entry: entries }
}

function fakeServer(server: FakeServer): ErasureRequest['upstreamFetch'] {
  return async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = url.slice(BASE.length + 1)
    server.calls.push(`${method} ${path}`)
    if (server.fail && path.startsWith(server.fail)) return new Response('boom', { status: 500 })
    if (path.startsWith('Condition/c1/_history')) return json(bundle(server.history.map((resource) => ({ resource }))))
    if (path.startsWith('Provenance?target=')) return json(bundle(server.provenance.map((resource) => ({ resource }))))
    if (path.startsWith('Condition?_id=')) {
      return json(bundle(server.referrers.map((resource) => ({ resource, search: { mode: 'include' } }))))
    }
    return json({ resourceType: 'OperationOutcome' })
  }
}

function condition(extra: Res = {}): Res {
  return { resourceType: 'Condition', id: 'c1', meta: { versionId: '1' }, subject: { reference: 'Patient/p1' }, ...extra }
}

async function addedBy(actor: string, version = '1'): Promise<Res> {
  const provenance = await addedByProvenance({ type: 'Condition', id: 'c1', version, chart: 'Patient/p1' }, actor)
  return { ...provenance, id: `added-${actor.replace('/', '-')}` }
}

function request(server: FakeServer, overrides: Partial<ErasureRequest> = {}): ErasureRequest {
  return {
    resourceType: 'Condition',
    resourceId: 'c1',
    tokenPayload: PATIENT,
    serverUrl: BASE,
    authHeader: 'Bearer t',
    upstreamFetch: fakeServer(server),
    expungeSupported: true,
    personPatient: async (person) => (person === 'Person/m1' ? 'Patient/p1' : undefined),
    ...overrides,
  }
}

async function server(partial: Partial<FakeServer> = {}): Promise<FakeServer> {
  return { history: [condition()], provenance: [await addedBy('Patient/p1')], referrers: [], calls: [], ...partial }
}

describe('eraseRecord', () => {
  it('deletes the record and the Provenance recording who added it, and expunges both', async () => {
    const s = await server()
    const result = await eraseRecord(request(s))
    expect(result.status).toBe(200)
    expect(s.calls).toContain('DELETE Provenance/added-Patient-p1')
    expect(s.calls).toContain('POST Provenance/added-Patient-p1/$expunge')
    expect(s.calls).toContain('DELETE Condition/c1')
    expect(s.calls[s.calls.length - 1]).toBe('POST Condition/c1/$expunge')
  })

  it('keeps a shared Provenance and only drops this target', async () => {
    const s = await server()
    s.provenance.push({
      resourceType: 'Provenance', id: 'pr2',
      target: [{ reference: 'Condition/c1/_history/2' }, { reference: 'Observation/o9' }, { reference: 'Patient/p1' }],
      agent: [{ who: { reference: 'Device/scribe' } }],
    })
    let putBody: unknown
    const base = fakeServer(s)
    const result = await eraseRecord(request(s, {
      upstreamFetch: async (url, init) => {
        if (init?.method === 'PUT') putBody = JSON.parse(String(init.body))
        return base(url, init)
      },
    }))
    expect(result.status).toBe(200)
    expect(s.calls).toContain('PUT Provenance/pr2')
    expect(s.calls).not.toContain('DELETE Provenance/pr2')
    expect(putBody).toMatchObject({ target: [{ reference: 'Observation/o9' }, { reference: 'Patient/p1' }] })
  })

  it('drops a Provenance left pointing at nothing but the chart', async () => {
    const s = await server()
    s.provenance.push({
      resourceType: 'Provenance', id: 'pr3',
      target: [{ reference: 'Condition/c1' }, { reference: 'Patient/p1' }],
      agent: [{ who: { reference: 'Patient/p1' } }],
    })
    expect((await eraseRecord(request(s))).status).toBe(200)
    expect(s.calls).toContain('DELETE Provenance/pr3')
  })

  it.each([
    ['a confirmed version in its history', { history: [condition({ meta: { versionId: '2' }, verificationStatus: { coding: [{ code: 'confirmed' }] } }), condition()] }],
    ['a clinician as asserter', { history: [condition({ asserter: { reference: 'Practitioner/dr1' } })] }],
    ['a performing organization', { history: [condition({ performer: [{ actor: { reference: 'Organization/lab' } }] })] }],
  ])('refuses a record with %s', async (_label, partial) => {
    const s = await server(partial)
    const result = await eraseRecord(request(s))
    expect(result.status).toBe(409)
    expect(s.calls.some((c) => c.startsWith('DELETE') || c.startsWith('PUT'))).toBe(false)
  })

  it('refuses a record a clinician Provenance attests', async () => {
    const s = await server()
    s.provenance.push({ resourceType: 'Provenance', id: 'p', target: [{ reference: 'Condition/c1' }], agent: [{ who: { reference: 'PractitionerRole/r1' } }] })
    expect((await eraseRecord(request(s))).status).toBe(409)
  })

  it('refuses a record about the member that someone else added', async () => {
    const s = await server({ provenance: [await addedBy('Patient/p2')] })
    const result = await eraseRecord(request(s))
    expect(result.status).toBe(403)
    expect(s.calls.some((c) => c.startsWith('DELETE'))).toBe(false)
  })

  it('refuses a record nobody is recorded as having added, whoever it is about', async () => {
    expect((await eraseRecord(request(await server({ provenance: [] }))))).toMatchObject({ status: 403 })
  })

  it('ignores a Provenance a client wrote claiming to have added the record', async () => {
    const relabelled = { ...(await addedBy('Patient/p2')), agent: [{ who: { reference: 'Patient/p1' } }] }
    const unsigned = {
      resourceType: 'Provenance', id: 'claim', policy: [ADDED_BY_POLICY],
      target: [{ reference: 'Condition/c1/_history/1' }], agent: [{ who: { reference: 'Patient/p1' } }],
    }
    expect((await eraseRecord(request(await server({ provenance: [relabelled, unsigned] }))))).toMatchObject({ status: 403 })
  })

  it('only counts the signature for the version the record was created as', async () => {
    const s = await server({ history: [condition({ meta: { versionId: '2' } }), condition()], provenance: [await addedBy('Patient/p1', '2')] })
    expect((await eraseRecord(request(s))).status).toBe(403)
  })

  it('lets whoever added a record erase it, including a caregiver signed in as their Person', async () => {
    const s = await server({ provenance: [await addedBy('Person/carer')] })
    const result = await eraseRecord(request(s, { tokenPayload: { fhirUser: 'Person/carer', patient: 'p1', scope: 'patient/Condition.cruds' } }))
    expect(result.status).toBe(200)
    expect(s.calls).toContain('DELETE Condition/c1')
  })

  it('matches a record added as the Patient when the member now signs in as their Person', async () => {
    const result = await eraseRecord(request(await server(), { tokenPayload: { fhirUser: 'Person/m1', scope: 'patient/Condition.cruds' } }))
    expect(result.status).toBe(200)
  })

  it('refuses clinicians and apps without a member behind them', async () => {
    const s = await server({ provenance: [await addedBy('Practitioner/dr1')] })
    expect((await eraseRecord(request(s, { tokenPayload: { fhirUser: 'Practitioner/dr1', patient: 'p1' } }))).status).toBe(403)
    expect((await eraseRecord(request(s, { tokenPayload: { scope: 'system/*.cruds' } }))).status).toBe(403)
  })

  it.each(['Patient', 'Person', 'Consent', 'Provenance', 'AuditEvent'])('keeps a %s', async (resourceType) => {
    const s = await server()
    expect((await eraseRecord(request(s, { resourceType }))).status).toBe(422)
    expect(s.calls).toHaveLength(0)
  })

  it('refuses while another record still references it', async () => {
    const s = await server({ referrers: [{ resourceType: 'Encounter', id: 'e1' }] })
    const result = await eraseRecord(request(s))
    expect(result.status).toBe(409)
    expect(JSON.stringify(result.body)).toContain('Encounter/e1')
  })

  it('refuses up front when the server cannot purge history', async () => {
    const s = await server()
    expect((await eraseRecord(request(s, { expungeSupported: false }))).status).toBe(501)
    expect(s.calls).toHaveLength(0)
  })

  it('reports an upstream failure instead of claiming success', async () => {
    const result = await eraseRecord(request(await server({ fail: 'Condition/c1/$expunge' })))
    expect(result.status).toBe(502)
  })

  it('answers 404 for a record that does not exist', async () => {
    expect((await eraseRecord(request(await server({ history: [] })))).status).toBe(404)
  })
})
