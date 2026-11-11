// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, spyOn } from 'bun:test'
import { admitDicomUpload, uploadedStudyUids, type UploadQuotaDeps, type UploadRequest } from '../src/lib/dicom-upload-admission'
import { addedByProvenance } from '../src/lib/fhir-authorship'
import { logger } from '../src/lib/logger'
import type { DicomServerConfigType, DicomStorageUsageType } from '../src/schemas'
import type { UpstreamFetch } from '../src/lib/upstream-fetch'
import { useTestEnv } from './helpers/test-env'

const SERVER: DicomServerConfigType = { id: 'orthanc', name: 'Orthanc', baseUrl: 'http://orthanc:8042/dicom-web', authType: 'none' }
const CLINICIAN = { sub: 'dr', fhirUser: 'Practitioner/dr', scope: 'openid user/*.cruds', membership_tier: 'free' }

function deps(usage: Partial<DicomStorageUsageType> | Error = {}): UploadQuotaDeps & { asked: string[][] } {
  const asked: string[][] = []
  return {
    asked,
    studiesUploadedBy: async () => ['1.2.1', '1.2.2'],
    measureFresh: async (uids) => {
      asked.push(uids)
      if (usage instanceof Error) throw usage
      return { studies: uids.length, bytes: 900, unmeasuredStudies: 0, ...usage }
    },
  }
}

function upload(overrides: Partial<UploadRequest> = {}): UploadRequest & { aborted: () => boolean } {
  let aborted = false
  return {
    caller: CLINICIAN,
    authHeader: 'Bearer t',
    body: new Blob([new Uint8Array(50)]).stream(),
    contentLength: '50',
    server: SERVER,
    abort: () => { aborted = true },
    aborted: () => aborted,
    ...overrides,
  }
}

describe('admitDicomUpload', () => {
  useTestEnv({ DICOM_STORAGE_QUOTAS: 'free=1000B,lite=10GB', MEMBERSHIP_TIER_CLAIM: undefined })

  it('admits an upload that fits what the plan has left', async () => {
    const quota = deps()
    const admission = await admitDicomUpload(upload(), quota)
    expect(admission.admitted).toBe(true)
    expect(quota.asked).toEqual([['1.2.1', '1.2.2']])
  })

  it('refuses a declared size past the plan before anything is sent', async () => {
    const request = upload({ contentLength: '101' })
    const admission = await admitDicomUpload(request, deps())
    expect(admission).toEqual({ admitted: false, refusal: { plan: 'free', usedBytes: 900, limitBytes: 1000, incomingBytes: 101 } })
    expect(request.aborted()).toBe(false)
  })

  it('meters a chunked upload and aborts it once it passes the plan', async () => {
    const request = upload({ contentLength: null, body: new Blob([new Uint8Array(150)]).stream() })
    const admission = await admitDicomUpload(request, deps())
    if (!admission.admitted || !admission.body) throw new Error('a chunked upload is admitted and metered')
    await expect(new Response(admission.body).arrayBuffer()).rejects.toThrow()
    expect(request.aborted()).toBe(true)
    expect(admission.overrun()).toEqual({ plan: 'free', usedBytes: 900, limitBytes: 1000, incomingBytes: 150 })
  })

  it('is unlimited without the tier claim, for an unconfigured tier, and for a system grant', async () => {
    const quota = deps()
    const { membership_tier: _tier, ...untiered } = CLINICIAN
    for (const caller of [untiered, { ...CLINICIAN, membership_tier: 'pro' }, { sub: 'svc', scope: 'system/*.cruds', membership_tier: 'free' }]) {
      const admission = await admitDicomUpload(upload({ caller, contentLength: '999999' }), quota)
      expect(admission.admitted).toBe(true)
      if (admission.admitted) expect(admission.overrun()).toBeNull()
    }
    expect(quota.asked).toEqual([])
  })

  it.serial('reads the tier from the configured claim', async () => {
    process.env.MEMBERSHIP_TIER_CLAIM = 'plan'
    const caller = { ...CLINICIAN, membership_tier: undefined, plan: 'free' }
    expect((await admitDicomUpload(upload({ caller, contentLength: '101' }), deps())).admitted).toBe(false)
  })

  it.serial('is unlimited with no quotas configured', async () => {
    process.env.DICOM_STORAGE_QUOTAS = ''
    const quota = deps()
    expect((await admitDicomUpload(upload({ contentLength: '999999' }), quota)).admitted).toBe(true)
    expect(quota.asked).toEqual([])
  })

  it.serial('fails open with a warning when the PACS cannot size studies or the lookup fails', async () => {
    const warn = spyOn(logger.fhir, 'warn')
    try {
      for (const quota of [deps({ bytes: null }), deps(new Error('PACS down'))]) {
        const admission = await admitDicomUpload(upload({ contentLength: '999999' }), quota)
        expect(admission.admitted).toBe(true)
      }
      const messages = warn.mock.calls.map(([message]) => message)
      expect(messages).toContain('Upload quota not applied: the PACS cannot report study sizes')
      expect(messages).toContain('Upload quota not applied: storage use could not be measured')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('uploadedStudyUids', () => {
  const FHIR = 'http://hapi:8080/fhir'
  const imagingStudy = (id: string, uid: string) => ({
    resourceType: 'ImagingStudy', id, meta: { versionId: '1' }, subject: { reference: 'Patient/p1' },
    identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${uid}` }],
  })
  const RECORDS: Record<string, Record<string, unknown>> = {
    'ImagingStudy/mine/_history/1': imagingStudy('mine', '1.2.1'),
    'ImagingStudy/theirs/_history/1': imagingStudy('theirs', '1.2.2'),
  }

  it('counts only the studies the proxy signed as the caller\'s uploads', async () => {
    const provenance = [
      await addedByProvenance({ type: 'ImagingStudy', id: 'mine', version: '1', chart: 'Patient/p1' }, 'Practitioner/dr'),
      { ...await addedByProvenance({ type: 'ImagingStudy', id: 'theirs', version: '1', chart: 'Patient/p1' }, 'Practitioner/other'),
        agent: [{ who: { reference: 'Practitioner/dr' } }] },
      await addedByProvenance({ type: 'Observation', id: 'o1', version: '1', chart: 'Patient/p1' }, 'Practitioner/dr'),
    ]
    const read: string[] = []
    const fetcher: UpstreamFetch = async (url, init) => {
      if (init?.method === 'POST') {
        const urls: string[] = JSON.parse(String(init.body)).entry.map((e: { request: { url: string } }) => e.request.url)
        read.push(...urls)
        return Response.json({ resourceType: 'Bundle', type: 'batch-response', entry: urls.map((u) => ({ resource: RECORDS[u], response: { status: '200 OK' } })) })
      }
      expect(url).toStartWith(`${FHIR}/Provenance?agent=${encodeURIComponent('Practitioner/dr')}`)
      return Response.json({ resourceType: 'Bundle', entry: provenance.map((resource) => ({ resource })) })
    }

    const uids = await uploadedStudyUids({ serverUrl: FHIR, serverName: 'hapi', authHeader: 'Bearer t', upstreamFetch: fetcher }, 'Practitioner/dr')
    expect(uids).toEqual(['1.2.1'])
    expect(read).toEqual(['ImagingStudy/mine/_history/1'])
  })
})
