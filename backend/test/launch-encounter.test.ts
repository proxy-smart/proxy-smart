// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { checkEncounterOfPatient, type ResourceRead } from '../src/lib/launch-encounter'

const SERVER = { fhirBase: 'https://proxy.example.org/proxy/hapi/R4', url: 'https://hapi.internal/fhir' }

const encounterFor = (subject: unknown): ResourceRead => ({ ok: true, resource: { resourceType: 'Encounter', id: '456', subject } })

function reader(read: ResourceRead) {
  const calls: string[] = []
  return {
    calls,
    read: async (type: string, id: string) => {
      calls.push(`${type}/${id}`)
      return read
    },
  }
}

describe('an encounter in launch context belongs to the patient in context', () => {
  it('accepts an encounter whose subject is the patient', async () => {
    const { read, calls } = reader(encounterFor({ reference: 'Patient/123' }))
    expect(await checkEncounterOfPatient('Patient/123', 'Encounter/456', SERVER, read)).toEqual({ ok: true })
    expect(calls).toEqual(['Encounter/456'])
  })

  it('accepts bare ids and a subject that is absolute on the same server', async () => {
    const { read } = reader(encounterFor({ reference: `${SERVER.url}/Patient/123` }))
    expect(await checkEncounterOfPatient('123', '456', SERVER, read)).toEqual({ ok: true })
  })

  it('refuses an encounter of another patient', async () => {
    const { read } = reader(encounterFor({ reference: 'Patient/999' }))
    expect(await checkEncounterOfPatient('Patient/123', 'Encounter/456', SERVER, read)).toMatchObject({
      ok: false,
      status: 400,
      error: 'invalid_request',
    })
  })

  it('refuses an encounter with no patient subject', async () => {
    const { read } = reader(encounterFor({ reference: 'Group/1' }))
    expect(await checkEncounterOfPatient('Patient/123', 'Encounter/456', SERVER, read)).toMatchObject({ ok: false, status: 400 })
    const { read: none } = reader(encounterFor(undefined))
    expect(await checkEncounterOfPatient('Patient/123', 'Encounter/456', SERVER, none)).toMatchObject({ ok: false, status: 400 })
  })

  it('passes on a read the server refused or could not answer', async () => {
    const { read: missing } = reader({ ok: false, status: 404, detail: 'gone' })
    expect(await checkEncounterOfPatient('Patient/123', 'Encounter/456', SERVER, missing)).toMatchObject({ ok: false, status: 400, error: 'invalid_request' })
    const { read: forbidden } = reader({ ok: false, status: 403, detail: 'scope' })
    expect(await checkEncounterOfPatient('Patient/123', 'Encounter/456', SERVER, forbidden)).toMatchObject({ ok: false, status: 403, error: 'access_denied' })
    const { read: down } = reader({ ok: false, status: 503, detail: 'down' })
    expect(await checkEncounterOfPatient('Patient/123', 'Encounter/456', SERVER, down)).toMatchObject({ ok: false, status: 502 })
  })

  it('refuses an encounter id that cannot be read safely', async () => {
    const { read, calls } = reader(encounterFor({ reference: 'Patient/123' }))
    expect(await checkEncounterOfPatient('Patient/123', 'Encounter/../x', SERVER, read)).toMatchObject({ ok: false, status: 400 })
    expect(calls).toEqual([])
  })
})
