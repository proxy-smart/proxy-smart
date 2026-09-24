// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The patient resolution shared by consent and compartment filtering. Pins the
 * source order and the refusals.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  normalizeFhirUser,
  resolveTokenPatient,
  resolveTokenPatientId,
  resolveTokenPatientIdViaPerson,
} from '../src/lib/patient-context'
import { clearPersonCache } from '../src/lib/consent/person-resolver'
import { tokenContextStore } from '../src/lib/token-context-store'

describe('normalizeFhirUser', () => {
  it('passes a relative reference through', () => {
    expect(normalizeFhirUser('Patient/1005')).toBe('Patient/1005')
    expect(normalizeFhirUser('Practitioner/dr-smith')).toBe('Practitioner/dr-smith')
  })

  it('reduces an absolute URL to a relative reference', () => {
    expect(normalizeFhirUser('https://fhir.example.com/R4/Patient/1005')).toBe('Patient/1005')
  })

  it('leaves an unrecognized value alone rather than guessing', () => {
    expect(normalizeFhirUser('not-a-reference')).toBe('not-a-reference')
  })
})

describe('resolveTokenPatient', () => {
  it('takes a patient claim first', () => {
    tokenContextStore.set('jti-a', { patient: 'from-store', clientId: 'app' })
    const resolved = resolveTokenPatient({
      patient: 'from-claim',
      jti: 'jti-a',
      azp: 'app',
      fhirUser: 'Patient/from-fhiruser',
    })
    expect(resolved).toEqual({ patient: 'from-claim', source: 'claim' })
  })

  it('falls to the stored launch context when there is no claim', () => {
    tokenContextStore.set('jti-b', { patient: 'p-123', clientId: 'app' })
    const resolved = resolveTokenPatient({ jti: 'jti-b', azp: 'app', fhirUser: 'Patient/other' })
    expect(resolved).toEqual({ patient: 'p-123', source: 'launch-context' })
  })

  it('refuses a stored context bound to a different client', () => {
    tokenContextStore.set('jti-c', { patient: 'p-123', clientId: 'app-a' })
    const resolved = resolveTokenPatient({ jti: 'jti-c', azp: 'app-b' })
    expect(resolved).toBeNull()
  })

  it('falls to a Patient fhirUser last', () => {
    const resolved = resolveTokenPatient({ fhirUser: 'Patient/1005' })
    expect(resolved).toEqual({ patient: 'Patient/1005', source: 'fhirUser' })
  })

  it('does not accept a non-Patient fhirUser as a compartment', () => {
    for (const fhirUser of ['Practitioner/dr-smith', 'Person/p-1', 'Device/d-1', 'RelatedPerson/r-1']) {
      expect(resolveTokenPatient({ fhirUser })).toBeNull()
    }
  })

  it('is null when the token says nothing', () => {
    expect(resolveTokenPatient({})).toBeNull()
    expect(resolveTokenPatient({ scope: 'patient/*.read' })).toBeNull()
  })

  it('ignores non-string claim values', () => {
    expect(resolveTokenPatient({ patient: 12345, fhirUser: null })).toBeNull()
  })
})

describe('resolveTokenPatientId', () => {
  it('strips the resource type off a reference', () => {
    expect(resolveTokenPatientId({ fhirUser: 'Patient/1005' })).toBe('1005')
  })

  it('returns a bare id unchanged', () => {
    expect(resolveTokenPatientId({ patient: 'p-123' })).toBe('p-123')
  })

  it('is null when nothing resolves', () => {
    expect(resolveTokenPatientId({ fhirUser: 'Practitioner/dr-smith' })).toBeNull()
  })
})

describe('resolveTokenPatientIdViaPerson', () => {
  const server = { url: 'http://fhir.test/fhir', identifier: 'test-server' }
  const ORIGINAL_FETCH = globalThis.fetch
  let requested: string[] = []

  const personWith = (links: string[]) => ({
    resourceType: 'Person',
    id: '1004',
    link: links.map((reference) => ({ target: { reference }, assurance: 'level3' })),
  })

  const serve = (body: unknown, status = 200) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/fhir+json' } })
    }) as typeof fetch
  }

  beforeEach(() => {
    requested = []
    clearPersonCache()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('follows a Person fhirUser to its linked Patient', async () => {
    serve(personWith(['Practitioner/dr-1', 'Patient/pat-42']))
    const id = await resolveTokenPatientIdViaPerson({ fhirUser: 'Person/1004' }, server, 'Bearer t')
    expect(id).toBe('pat-42')
    expect(requested).toEqual(['http://fhir.test/fhir/Person/1004'])
  })

  it('does not read the Person when the token already names a patient', async () => {
    serve(personWith(['Patient/other']))
    const id = await resolveTokenPatientIdViaPerson(
      { patient: 'pat-1', fhirUser: 'Person/1004' }, server, 'Bearer t',
    )
    expect(id).toBe('pat-1')
    expect(requested).toEqual([])
  })

  it('is null when the Person links no Patient', async () => {
    serve(personWith(['Practitioner/dr-1']))
    expect(await resolveTokenPatientIdViaPerson({ fhirUser: 'Person/1004' }, server, 'Bearer t')).toBeNull()
  })

  it('is null when the Person cannot be read', async () => {
    serve({ resourceType: 'OperationOutcome' }, 404)
    expect(await resolveTokenPatientIdViaPerson({ fhirUser: 'Person/1004' }, server, 'Bearer t')).toBeNull()
  })

  it('is null without any fhirUser', async () => {
    serve(personWith(['Patient/pat-42']))
    expect(await resolveTokenPatientIdViaPerson({}, server, 'Bearer t')).toBeNull()
    expect(requested).toEqual([])
  })
})
