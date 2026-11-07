// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import { clearSharedStudiesCache, patientStudyUids, sharedStudyUids, type SharedStudiesDeps } from '../src/lib/shl/shared-studies'

const SERVER = 'http://fhir.test/fhir'
const PATIENT = 'p1'

function study(id: string, uid: string, patient: string) {
  return {
    resource: {
      resourceType: 'ImagingStudy',
      id,
      status: 'available',
      subject: { reference: `Patient/${patient}` },
      identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${uid}` }],
    },
  }
}

function deps(entries: unknown[], status = 200): SharedStudiesDeps & { urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    token: async () => 'service-token',
    fetch: async (url) => {
      urls.push(url)
      return Response.json({ resourceType: 'Bundle', type: 'searchset', entry: entries }, { status })
    },
  }
}

const BUNDLE = [study('a', '1.1', PATIENT), study('b', '1.2', PATIENT), study('c', '9.9', 'p2')]

describe('studies a share link holds', () => {
  beforeEach(clearSharedStudiesCache)

  it('lists the shared patient\'s studies and none of another patient\'s', async () => {
    const d = deps(BUNDLE)
    expect(await patientStudyUids({ patientId: PATIENT, fhirServerUrl: SERVER }, d)).toEqual(['1.1', '1.2'])
    expect(new URL(d.urls[0]).searchParams.get('patient')).toBe(`Patient/${PATIENT}`)
  })

  it('narrows a study-scoped share to its study, and to nothing when the study is not the patient\'s', async () => {
    expect(await patientStudyUids({ patientId: PATIENT, fhirServerUrl: SERVER, studyInstanceUID: '1.2' }, deps(BUNDLE))).toEqual(['1.2'])
    expect(await patientStudyUids({ patientId: PATIENT, fhirServerUrl: SERVER, studyInstanceUID: '9.9' }, deps(BUNDLE))).toEqual([])
  })

  it('leaves out studies the patient chose not to share', async () => {
    const selective = { excludedTypes: [], excludedIds: ['ImagingStudy/a'], excludedObservationCategories: [] }
    expect(await patientStudyUids({ patientId: PATIENT, fhirServerUrl: SERVER, selective }, deps(BUNDLE))).toEqual(['1.2'])
  })

  it('answers null when the studies cannot be listed', async () => {
    expect(await patientStudyUids({ patientId: PATIENT, fhirServerUrl: SERVER }, deps([], 500))).toBeNull()
    const noToken = { ...deps(BUNDLE), token: async () => { throw new Error('no token') } }
    expect(await patientStudyUids({ patientId: PATIENT, fhirServerUrl: SERVER }, noToken)).toBeNull()
  })

  it('asks FHIR once per link while the answer is fresh, and again after a failed lookup', async () => {
    const failing = deps([], 503)
    expect(await sharedStudyUids('shl-1', { patientId: PATIENT, fhirServerUrl: SERVER }, failing)).toBeNull()
    const d = deps(BUNDLE)
    await sharedStudyUids('shl-1', { patientId: PATIENT, fhirServerUrl: SERVER }, d)
    await sharedStudyUids('shl-1', { patientId: PATIENT, fhirServerUrl: SERVER }, d)
    expect(d.urls).toHaveLength(1)
  })
})
