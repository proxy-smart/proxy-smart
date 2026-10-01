// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
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
  return { resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/p1' }, ...extra }
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
    ...overrides,
  }
}

function server(partial: Partial<FakeServer> = {}): FakeServer {
  return { history: [condition()], provenance: [], referrers: [], calls: [], ...partial }
}

describe('eraseRecord', () => {
  it('deletes the record, removes a Provenance about it alone, and expunges both', async () => {
    const s = server({
      provenance: [{ resourceType: 'Provenance', id: 'pr1', target: [{ reference: 'Condition/c1' }], agent: [{ who: { reference: 'Patient/p1' } }] }],
    })
    const result = await eraseRecord(request(s))
    expect(result.status).toBe(200)
    expect(s.calls).toContain('DELETE Provenance/pr1')
    expect(s.calls).toContain('POST Provenance/pr1/$expunge')
    expect(s.calls).toContain('DELETE Condition/c1')
    expect(s.calls[s.calls.length - 1]).toBe('POST Condition/c1/$expunge')
  })

  it('keeps a shared Provenance and only drops this target', async () => {
    const s = server({
      provenance: [{
        resourceType: 'Provenance', id: 'pr2',
        target: [{ reference: 'Condition/c1/_history/2' }, { reference: 'Observation/o9' }],
        agent: [{ who: { reference: 'Device/scribe' } }],
      }],
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
    expect(putBody).toMatchObject({ target: [{ reference: 'Observation/o9' }] })
  })

  it.each([
    ['a confirmed version in its history', { history: [condition({ verificationStatus: { coding: [{ code: 'confirmed' }] } }), condition()] }],
    ['a clinician as asserter', { history: [condition({ asserter: { reference: 'Practitioner/dr1' } })] }],
    ['a performing organization', { history: [condition({ performer: [{ actor: { reference: 'Organization/lab' } }] })] }],
    ['a clinician Provenance agent', { provenance: [{ resourceType: 'Provenance', id: 'p', target: [{ reference: 'Condition/c1' }], agent: [{ who: { reference: 'PractitionerRole/r1' } }] }] }],
  ])('refuses a record with %s', async (_label, partial) => {
    const s = server(partial)
    const result = await eraseRecord(request(s))
    expect(result.status).toBe(409)
    expect(s.calls.some((c) => c.startsWith('DELETE') || c.startsWith('PUT'))).toBe(false)
  })

  it('refuses anyone but the patient the record belongs to', async () => {
    const practitioner = { fhirUser: 'Practitioner/dr1', patient: 'p1' }
    expect((await eraseRecord(request(server(), { tokenPayload: practitioner }))).status).toBe(403)
    expect((await eraseRecord(request(server({ history: [condition({ subject: { reference: 'Patient/p2' } })] })))).status).toBe(403)
    expect((await eraseRecord(request(server(), { tokenPayload: { fhirUser: 'Patient/p1', patient: 'p2' } }))).status).toBe(403)
  })

  it('refuses while another record still references it', async () => {
    const s = server({ referrers: [{ resourceType: 'Encounter', id: 'e1' }] })
    const result = await eraseRecord(request(s))
    expect(result.status).toBe(409)
    expect(JSON.stringify(result.body)).toContain('Encounter/e1')
  })

  it('refuses up front when the server cannot purge history', async () => {
    const s = server()
    expect((await eraseRecord(request(s, { expungeSupported: false }))).status).toBe(501)
    expect(s.calls).toHaveLength(0)
  })

  it('reports an upstream failure instead of claiming success', async () => {
    const result = await eraseRecord(request(server({ fail: 'Condition/c1/$expunge' })))
    expect(result.status).toBe(502)
  })

  it('answers 404 for a record that does not exist', async () => {
    expect((await eraseRecord(request(server({ history: [] })))).status).toBe(404)
  })
})
