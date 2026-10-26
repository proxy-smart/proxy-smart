// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { beforeEach, describe, expect, it } from 'bun:test'
import {
  CUSTODIAN_ROLE, enforceRecordCustody, invalidateRecordCustody, isRecordClosed, refusesNewData, screenClosedRecords,
} from '../src/lib/consent/record-custody'
import type { AccessControlContext } from '../src/lib/smart-access-control'

const BASE = 'http://fhir.test/fhir'
type Res = Record<string, unknown>

function holding(patient: string, status: string): Res {
  return {
    resourceType: 'Consent', id: `hold-${patient}`, status, patient: { reference: `Patient/${patient}` },
    provision: { type: 'permit', actor: [{ role: { coding: [CUSTODIAN_ROLE] }, reference: { reference: 'Organization/mh' } }] },
  }
}

function grant(patient: string, status: string): Res {
  return {
    resourceType: 'Consent', id: `grant-${patient}`, status, patient: { reference: `Patient/${patient}` },
    provision: { type: 'permit', actor: [{ role: { coding: [{ code: 'PRCP' }] }, reference: { reference: 'Practitioner/dr' } }] },
  }
}

interface Upstream {
  consents: Res[]
  stored: Record<string, Res>
  lookups: number
  failing: boolean
}

function upstream(partial: Partial<Upstream> = {}): Upstream {
  return { consents: [holding('closed', 'inactive'), holding('open', 'active')], stored: {}, lookups: 0, failing: false, ...partial }
}

function bundleOf(resources: Res[]): Response {
  return new Response(JSON.stringify({ resourceType: 'Bundle', entry: resources.map((resource) => ({ resource })) }), { status: 200 })
}

function fetcher(u: Upstream): AccessControlContext['upstreamFetch'] {
  return async (url) => {
    if (u.failing) return new Response('down', { status: 500 })
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/Consent')) {
      u.lookups++
      const asked = (parsed.searchParams.get('patient') ?? '').split(',')
      return bundleOf(u.consents.filter((c) => asked.includes(String((c.patient as Res).reference))))
    }
    const type = parsed.pathname.split('/').pop() ?? ''
    const stored = u.stored[`${type}/${parsed.searchParams.get('_id')}`]
    return bundleOf(stored ? [stored] : [])
  }
}

function ctx(u: Upstream, method: string, resourcePath: string, tokenPayload: Res): AccessControlContext {
  return {
    tokenPayload, resourcePath, method, serverUrl: BASE, serverId: 'hapi', serverName: 'hapi', authHeader: 'Bearer t', upstreamFetch: fetcher(u),
  }
}

const member = { fhirUser: 'Patient/closed', patient: 'closed' }
const clinicianInChart = { fhirUser: 'Practitioner/dr', patient: 'closed' }
const clinician = { fhirUser: 'Practitioner/dr', scope: 'user/*.cruds' }
const observation = (patient: string) => JSON.stringify({ resourceType: 'Observation', subject: { reference: `Patient/${patient}` } })

beforeEach(() => invalidateRecordCustody())

describe('isRecordClosed', () => {
  it('is closed only when every record-holding consent ended', () => {
    expect(isRecordClosed([holding('p', 'inactive')])).toBe(true)
    expect(isRecordClosed([holding('p', 'inactive'), { ...holding('p', 'active'), id: 'again' }])).toBe(false)
    expect(isRecordClosed([grant('p', 'inactive')])).toBe(false)
    expect(isRecordClosed([])).toBe(false)
  })
})

describe('enforceRecordCustody', () => {
  it('lets the member read their closed record and remove what is theirs, and nothing more', async () => {
    const u = upstream()
    expect(await enforceRecordCustody(ctx(u, 'GET', 'Observation', member))).toEqual({ allowed: true, screenReads: false })
    expect((await enforceRecordCustody(ctx(u, 'DELETE', 'Observation/o1', member))).allowed).toBe(true)
    expect((await enforceRecordCustody(ctx(u, 'POST', 'Observation/o1/$erase', member))).allowed).toBe(true)
    expect(await enforceRecordCustody(ctx(u, 'POST', 'Observation', member), observation('closed'))).toMatchObject({ allowed: false, status: 403, error: 'record_closed' })
    expect((await enforceRecordCustody(ctx(u, 'PUT', 'Observation/o1', member), observation('closed'))).allowed).toBe(false)
  })

  it('keeps consent manageable, so the record can be opened again', async () => {
    expect((await enforceRecordCustody(ctx(upstream(), 'PUT', 'Consent/hold-closed', clinicianInChart))).allowed).toBe(true)
  })

  it('refuses a clinician in a closed chart outright', async () => {
    expect((await enforceRecordCustody(ctx(upstream(), 'GET', 'Observation', clinicianInChart))).allowed).toBe(false)
  })

  it('leaves an open record and an ungoverned one alone', async () => {
    const u = upstream()
    expect((await enforceRecordCustody(ctx(u, 'POST', 'Observation', { fhirUser: 'Practitioner/dr', patient: 'open' }), observation('open'))).allowed).toBe(true)
    expect((await enforceRecordCustody(ctx(u, 'POST', 'Observation', { fhirUser: 'Patient/legacy' }), observation('legacy'))).allowed).toBe(true)
  })

  it('screens reads by a caller with no patient in context, and refuses their writes into a closed record', async () => {
    const u = upstream({ stored: { 'Observation/o1': JSON.parse(observation('closed')) } })
    expect(await enforceRecordCustody(ctx(u, 'GET', 'Observation', clinician))).toEqual({ allowed: true, screenReads: true })
    expect((await enforceRecordCustody(ctx(u, 'POST', 'Observation', clinician), observation('closed'))).allowed).toBe(false)
    expect((await enforceRecordCustody(ctx(u, 'POST', 'Observation', clinician), observation('open'))).allowed).toBe(true)
    expect((await enforceRecordCustody(ctx(u, 'DELETE', 'Observation/o1', clinician))).allowed).toBe(false)
  })

  it('fails closed when it cannot tell whether the record is open', async () => {
    expect(await enforceRecordCustody(ctx(upstream({ failing: true }), 'GET', 'Observation', member))).toMatchObject({ allowed: false, status: 502 })
  })

  it('looks each patient up once until told the consent changed', async () => {
    const u = upstream()
    await enforceRecordCustody(ctx(u, 'GET', 'Observation', member))
    await enforceRecordCustody(ctx(u, 'GET', 'Condition', member))
    expect(u.lookups).toBe(1)
    u.consents = [holding('closed', 'active')]
    invalidateRecordCustody('closed')
    expect((await enforceRecordCustody(ctx(u, 'POST', 'Observation', member), observation('closed'))).allowed).toBe(true)
  })
})

describe('screenClosedRecords', () => {
  const custody = (u: Upstream) => ({ serverUrl: BASE, serverId: 'hapi', serverName: 'hapi', authHeader: 'Bearer t', upstreamFetch: fetcher(u) })

  it('takes closed records out of a search, and refuses a closed resource read on its own', async () => {
    const u = upstream()
    const search = {
      resourceType: 'Bundle', type: 'searchset',
      entry: [{ resource: JSON.parse(observation('closed')) }, { resource: JSON.parse(observation('open')) }, { resource: { resourceType: 'Patient', id: 'closed' } }],
    }
    const screened = await screenClosedRecords(custody(u), { status: 200, body: search })
    expect(screened.body).toMatchObject({ entry: [{ resource: { subject: { reference: 'Patient/open' } } }] })
    expect((await screenClosedRecords(custody(u), { status: 200, body: { resourceType: 'Patient', id: 'closed' } })).status).toBe(403)
    expect((await screenClosedRecords(custody(u), { status: 200, body: JSON.parse(observation('open')) })).status).toBe(200)
  })
})

describe('refusesNewData', () => {
  it('answers for uploads outside the FHIR pipeline', async () => {
    const custody = { serverUrl: BASE, serverId: 'hapi', serverName: 'hapi', authHeader: 'Bearer t', upstreamFetch: fetcher(upstream()) }
    expect(await refusesNewData(custody, 'closed')).toBe(true)
    expect(await refusesNewData(custody, 'open')).toBe(false)
  })
})
