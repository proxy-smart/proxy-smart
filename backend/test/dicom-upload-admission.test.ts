// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, spyOn } from 'bun:test'
import {
  admitDicomUpload,
  askAdmissionService,
  parseAdmissionAnswer,
  uploadedStudyUids,
  type AdmissionAnswer,
  type AdmissionQuestion,
  type UploadAdmissionDeps,
  type UploadRequest,
} from '../src/lib/dicom-upload-admission'
import { addedByProvenance } from '../src/lib/fhir-authorship'
import { logger } from '../src/lib/logger'
import type { DicomServerConfigType, DicomStorageUsageType } from '../src/schemas'
import type { UpstreamFetch } from '../src/lib/upstream-fetch'
import { useTestEnv } from './helpers/test-env'

const SERVER: DicomServerConfigType = { id: 'orthanc', name: 'Orthanc', baseUrl: 'http://orthanc:8042/dicom-web', authType: 'none' }
const CLINICIAN = { sub: 'dr', azp: 'viewer', fhirUser: 'Practitioner/dr', scope: 'openid user/*.cruds' }

function deps(answer: AdmissionAnswer | Error = { allow: true, limitBytes: 1000 }, usage: Partial<DicomStorageUsageType> | Error = {}) {
  const measured: string[][] = []
  const questions: AdmissionQuestion[] = []
  const d: UploadAdmissionDeps = {
    studiesUploadedBy: async () => ['1.2.1', '1.2.2'],
    measureFresh: async (uids) => {
      measured.push(uids)
      if (usage instanceof Error) throw usage
      return { studies: uids.length, bytes: 900, unmeasuredStudies: 0, ...usage }
    },
    ask: async (_service, question) => {
      questions.push(question)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { ...d, measured, questions }
}

function upload(overrides: Partial<UploadRequest> = {}): UploadRequest & { aborted: () => boolean } {
  let aborted = false
  return {
    caller: CLINICIAN,
    authHeader: 'Bearer t',
    subPath: '/studies/1.2.9',
    body: new Blob([new Uint8Array(50)]).stream(),
    contentLength: '50',
    server: SERVER,
    abort: () => { aborted = true },
    aborted: () => aborted,
    ...overrides,
  }
}

describe('admitDicomUpload', () => {
  useTestEnv({ DICOM_UPLOAD_ADMISSION_URL: 'https://admission.example.com/check', DICOM_UPLOAD_ADMISSION_ON_ERROR: undefined })

  it('asks the admission service with the caller, the measured usage and the declared size', async () => {
    const d = deps()
    expect((await admitDicomUpload(upload(), d)).admitted).toBe(true)
    expect(d.measured).toEqual([['1.2.1', '1.2.2']])
    expect(d.questions).toEqual([{
      subject: 'dr', fhirUser: 'Practitioner/dr', clientId: 'viewer', usedBytes: 900, incomingBytes: 50, studyInstanceUid: '1.2.9', dicomServerId: 'orthanc',
    }])
  })

  it('refuses with 413 what the service refuses, naming its limit and reason', async () => {
    const request = upload({ contentLength: '101' })
    const admission = await admitDicomUpload(request, deps({ allow: false, limitBytes: 1000, reason: 'Storage is full' }))
    expect(admission).toEqual({ admitted: false, status: 413, refusal: { usedBytes: 900, limitBytes: 1000, incomingBytes: 101, reason: 'Storage is full' } })
    expect(request.aborted()).toBe(false)
  })

  it('asks about a chunked upload with no size, and meters it against the limit the service names', async () => {
    const request = upload({ contentLength: null, body: new Blob([new Uint8Array(150)]).stream() })
    const d = deps({ allow: true, limitBytes: 1000 })
    const admission = await admitDicomUpload(request, d)
    expect(d.questions[0].incomingBytes).toBeNull()
    if (!admission.admitted || !admission.body) throw new Error('a chunked upload is admitted and metered')
    await expect(new Response(admission.body).arrayBuffer()).rejects.toThrow()
    expect(request.aborted()).toBe(true)
    expect(admission.overrun()).toEqual({ usedBytes: 900, limitBytes: 1000, incomingBytes: 150 })
  })

  it('passes an upload through unmetered when the service names no limit', async () => {
    const admission = await admitDicomUpload(upload({ contentLength: null }), deps({ allow: true }))
    if (!admission.admitted || !admission.body) throw new Error('admitted')
    expect((await new Response(admission.body).arrayBuffer()).byteLength).toBe(50)
    expect(admission.overrun()).toBeNull()
  })

  it('never asks for a system grant or a caller without a fhirUser', async () => {
    const d = deps({ allow: false })
    for (const caller of [{ sub: 'svc', scope: 'system/*.cruds' }, { sub: 'u', scope: 'openid' }]) {
      expect((await admitDicomUpload(upload({ caller }), d)).admitted).toBe(true)
    }
    expect(d.questions).toEqual([])
  })

  it.serial('is unlimited without a configured service', async () => {
    process.env.DICOM_UPLOAD_ADMISSION_URL = ''
    const d = deps({ allow: false })
    expect((await admitDicomUpload(upload(), d)).admitted).toBe(true)
    expect(d.measured).toEqual([])
  })

  it.serial('fails open with a warning when the PACS cannot size studies or the lookup fails', async () => {
    const warn = spyOn(logger.fhir, 'warn')
    try {
      for (const d of [deps({ allow: false }, { bytes: null }), deps({ allow: false }, new Error('PACS down'))]) {
        expect((await admitDicomUpload(upload(), d)).admitted).toBe(true)
        expect(d.questions).toEqual([])
      }
      const messages = warn.mock.calls.map(([message]) => message)
      expect(messages).toContain('Upload admission skipped: the PACS cannot report study sizes')
      expect(messages).toContain('Upload admission skipped: storage use could not be measured')
    } finally {
      warn.mockRestore()
    }
  })

  it.serial('admits with a warning when the service cannot be asked, by default', async () => {
    const warn = spyOn(logger.fhir, 'warn')
    try {
      expect((await admitDicomUpload(upload(), deps(new Error('timeout')))).admitted).toBe(true)
      expect(warn.mock.calls.map(([message]) => message)).toContain('The upload admission service could not be asked')
    } finally {
      warn.mockRestore()
    }
  })

  it.serial('answers 503 when the service cannot be asked and errors are set to deny', async () => {
    process.env.DICOM_UPLOAD_ADMISSION_ON_ERROR = 'deny'
    expect(await admitDicomUpload(upload(), deps(new Error('timeout')))).toEqual({ admitted: false, status: 503 })
  })
})

describe('the admission service call', () => {
  const SERVICE = { url: 'https://admission.example.com/check', secret: 's3cret', timeoutMs: 1000, onError: 'allow' as const }
  const QUESTION: AdmissionQuestion = { subject: 'dr', fhirUser: 'Practitioner/dr', clientId: 'viewer', usedBytes: 1, incomingBytes: null, studyInstanceUid: null, dicomServerId: null }

  it('POSTs the question as JSON with the shared secret as a bearer token', async () => {
    const sent: { url: string; init?: RequestInit }[] = []
    const fetcher: UpstreamFetch = async (url, init) => {
      sent.push({ url: String(url), init })
      return Response.json({ allow: true, limitBytes: 10 })
    }
    expect(await askAdmissionService(fetcher)(SERVICE, QUESTION)).toEqual({ allow: true, limitBytes: 10 })
    expect(sent[0].url).toBe(SERVICE.url)
    expect(new Headers(sent[0].init?.headers).get('authorization')).toBe('Bearer s3cret')
    expect(JSON.parse(String(sent[0].init?.body))).toEqual(QUESTION)
  })

  it('throws on a non-2xx answer or one without a boolean allow', async () => {
    await expect(askAdmissionService(async () => new Response('', { status: 500 }))(SERVICE, QUESTION)).rejects.toThrow()
    await expect(askAdmissionService(async () => Response.json({ allow: 'yes' }))(SERVICE, QUESTION)).rejects.toThrow()
  })

  it('reads only a usable answer', () => {
    expect(parseAdmissionAnswer({ allow: false, reason: 'full' })).toEqual({ allow: false, reason: 'full' })
    expect(parseAdmissionAnswer({ allow: true, limitBytes: -1 })).toBeNull()
    expect(parseAdmissionAnswer(null)).toBeNull()
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
