// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { confineToSharedPatient, screenSharedPatientAnswer } from '../src/lib/shl/patient-scope'
import { isRecord } from '../src/lib/type-guards'

const PATIENT = 'p1'
const SERVER = 'https://fhir.test/fhir'

function confine(fhirPath: string, search = '', method = 'GET') {
  return confineToSharedPatient({ method, fhirPath, search }, { patientId: PATIENT, serverUrl: SERVER })
}

function entryIds(body: unknown): unknown[] {
  if (!isRecord(body) || !Array.isArray(body.entry)) return []
  return body.entry.map((entry) => (isRecord(entry) && isRecord(entry.resource) ? entry.resource.id : undefined))
}

function query(search: string | undefined): URLSearchParams {
  return new URLSearchParams((search ?? '').replace(/^\?/, ''))
}

describe('confineToSharedPatient: paths', () => {
  it('allows the capability statement', () => {
    expect(confine('metadata').allowed).toBe(true)
  })

  it('allows reading the shared patient and refuses any other', () => {
    expect(confine(`Patient/${PATIENT}`).allowed).toBe(true)
    expect(confine('Patient/p2').allowed).toBe(false)
  })

  it('allows the shared patient compartment and refuses another patient compartment', () => {
    expect(confine(`Patient/${PATIENT}/Observation`).allowed).toBe(true)
    expect(confine('Patient/p2/Observation').allowed).toBe(false)
  })

  it('refuses compartments other than Patient', () => {
    expect(confine('Encounter/e1/Observation').allowed).toBe(false)
  })

  it('allows operations on the shared patient only', () => {
    expect(confine(`Patient/${PATIENT}/$everything`).allowed).toBe(true)
    expect(confine('Patient/p2/$everything').allowed).toBe(false)
    expect(confine('Observation/$lastn').allowed).toBe(false)
    expect(confine('$export').allowed).toBe(false)
  })

  it('refuses type-level history and allows instance history', () => {
    expect(confine('Observation/_history').allowed).toBe(false)
    expect(confine('Observation/o1/_history').allowed).toBe(true)
  })

  it('refuses a search at the server base but allows a page continuation', () => {
    expect(confine('', '?_type=Observation').allowed).toBe(false)
    expect(confine('', '').allowed).toBe(false)
    expect(confine('', '?_getpages=abc&_getpagesoffset=20&_count=20').allowed).toBe(true)
  })

  it('allows instance reads, verified against the answer', () => {
    expect(confine('Encounter/e1').allowed).toBe(true)
    expect(confine('Practitioner/dr1').allowed).toBe(true)
  })
})

describe('confineToSharedPatient: searches', () => {
  it('narrows a compartment search to the shared patient', () => {
    const decision = confine('Observation', '?code=1234-5')
    expect(decision.allowed).toBe(true)
    const params = query(decision.rewrittenSearch)
    expect(params.getAll('patient')).toContain(`Patient/${PATIENT}`)
    expect(params.get('code')).toBe('1234-5')
  })

  it('narrows a Patient search to the shared patient id', () => {
    const decision = confine('Patient', '?name=smith')
    expect(decision.allowed).toBe(true)
    expect(query(decision.rewrittenSearch).getAll('_id')).toContain(PATIENT)
  })

  it('refuses a search naming another patient', () => {
    expect(confine('Observation', '?subject=Patient/p2').allowed).toBe(false)
    expect(confine('Observation', '?patient=p2').allowed).toBe(false)
    expect(confine('Observation', '?subject:Patient=p2').allowed).toBe(false)
    expect(confine('Observation', '?patient=p1,p2').allowed).toBe(false)
    expect(confine('Patient', '?_id=p2').allowed).toBe(false)
    expect(confine('Encounter', '?subject=https://elsewhere.test/fhir/Patient/p2').allowed).toBe(false)
  })

  it('accepts a search that already names the shared patient', () => {
    expect(confine('Observation', `?subject=Patient/${PATIENT}`).allowed).toBe(true)
    expect(confine('Observation', `?patient=${PATIENT}`).allowed).toBe(true)
    expect(confine('Patient', `?_id=${PATIENT}`).allowed).toBe(true)
  })

  it('leaves searches of types outside the compartment unnarrowed', () => {
    const decision = confine('Practitioner', '?name=jones')
    expect(decision.allowed).toBe(true)
    expect(query(decision.rewrittenSearch).has('patient')).toBe(false)
  })

  it('refuses a Binary search, which no parameter confines', () => {
    expect(confine('Binary').allowed).toBe(false)
  })

  it('drops a requested response format so the answer can be checked', () => {
    const decision = confine('Observation', '?_format=xml')
    expect(decision.allowed).toBe(true)
    expect(query(decision.rewrittenSearch).has('_format')).toBe(false)
  })
})

describe('screenSharedPatientAnswer', () => {
  const own = { resourceType: 'Observation', id: 'o1', subject: { reference: `Patient/${PATIENT}` } }
  const ownAbsolute = { resourceType: 'Observation', id: 'o3', subject: { reference: `${SERVER}/Patient/${PATIENT}` } }
  const other = { resourceType: 'Observation', id: 'o2', subject: { reference: 'Patient/p2' } }
  const practitioner = { resourceType: 'Practitioner', id: 'dr1' }

  it('drops entries that belong to another patient', () => {
    const bundle = {
      resourceType: 'Bundle', type: 'searchset', total: 4,
      entry: [{ resource: own }, { resource: other }, { resource: practitioner }, { resource: ownAbsolute }],
    }
    const result = screenSharedPatientAnswer(bundle, { patientId: PATIENT, serverUrl: SERVER })
    expect(result.denied).toBe(false)
    expect(entryIds(result.body)).toEqual(['o1', 'dr1', 'o3'])
  })

  it('drops another Patient pulled in by an include', () => {
    const bundle = { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: { resourceType: 'Patient', id: 'p2' } }] }
    const result = screenSharedPatientAnswer(bundle, { patientId: PATIENT, serverUrl: SERVER })
    expect(entryIds(result.body)).toHaveLength(0)
  })

  it('denies a single resource of another patient', () => {
    expect(screenSharedPatientAnswer(other, { patientId: PATIENT, serverUrl: SERVER }).denied).toBe(true)
    expect(screenSharedPatientAnswer({ resourceType: 'Patient', id: 'p2' }, { patientId: PATIENT, serverUrl: SERVER }).denied).toBe(true)
  })

  it('keeps the shared patient even when it links to another patient', () => {
    const patient = { resourceType: 'Patient', id: PATIENT, link: [{ other: { reference: 'Patient/p9' }, type: 'seealso' }] }
    expect(screenSharedPatientAnswer(patient, { patientId: PATIENT, serverUrl: SERVER }).denied).toBe(false)
  })

  it('denies a compartment resource that names no patient', () => {
    const orphan = { resourceType: 'Encounter', id: 'e1' }
    expect(screenSharedPatientAnswer(orphan, { patientId: PATIENT, serverUrl: SERVER }).denied).toBe(true)
  })

  it('keeps resources outside the compartment and non-resource payloads', () => {
    expect(screenSharedPatientAnswer(practitioner, { patientId: PATIENT, serverUrl: SERVER }).denied).toBe(false)
    expect(screenSharedPatientAnswer('plain', { patientId: PATIENT, serverUrl: SERVER }).denied).toBe(false)
  })
})
