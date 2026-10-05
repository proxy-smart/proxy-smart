// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * DICOMweb requests are authorized through the caller's access to the FHIR ImagingStudy, so the
 * same scope, compartment and consent decisions govern the images as the records.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  authorizeDicomRead,
  authorizeDicomStore,
  clearDicomAccessCache,
  type DicomAccessDeps,
} from '../src/lib/dicomweb-access'

const OWN = '1.2.3.1'
const OTHER = '1.2.3.2'
const MEMBER = { sub: 'member', jti: 'jti-member', scope: 'openid patient/ImagingStudy.rs', exp: Math.floor(Date.now() / 1000) + 300 }

function deps(visible: string[], overrides: Partial<DicomAccessDeps> = {}): DicomAccessDeps & { searches: string[] } {
  const searches: string[] = []
  return {
    searches,
    mode: () => 'enforce',
    searchImagingStudies: async (_auth, query) => {
      searches.push(query)
      const uid = new URLSearchParams(query).get('identifier')?.replace('urn:oid:', '')
      return { status: 200, studyUids: uid ? visible.filter((v) => v === uid) : visible }
    },
    callerIdentity: async () => ({ patientId: 'own-patient', practitioner: false }),
    ...overrides,
  }
}

describe('DICOMweb reads', () => {
  beforeEach(clearDicomAccessCache)

  it('serves a study the caller can read as an ImagingStudy', async () => {
    const decision = await authorizeDicomRead(MEMBER, 'Bearer t', `/studies/${OWN}/series/9.9/instances`, '', deps([OWN]))
    expect(decision).toEqual({ allowed: true })
  })

  it('refuses a study the caller cannot read', async () => {
    const decision = await authorizeDicomRead(MEMBER, 'Bearer t', `/studies/${OTHER}/series/9.9/instances/8.8/frames/1`, '', deps([OWN]))
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.status).toBe(403)
  })

  it('asks FHIR once per token and study, however many frames follow', async () => {
    const d = deps([OWN])
    for (let frame = 1; frame <= 5; frame++) {
      await authorizeDicomRead(MEMBER, 'Bearer t', `/studies/${OWN}/series/9.9/instances/8.8/frames/${frame}`, '', d)
    }
    expect(d.searches).toHaveLength(1)
  })

  it('narrows a study search to the studies the caller can read', async () => {
    const decision = await authorizeDicomRead(MEMBER, 'Bearer t', '/studies', '?includefield=00081030', deps([OWN, '1.2.3.3']))
    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      const params = new URLSearchParams(decision.rewrittenQuery)
      expect(params.get('includefield')).toBe('00081030')
      expect(params.get('StudyInstanceUID')?.split(',').sort()).toEqual([OWN, '1.2.3.3'].sort())
    }
  })

  it('keeps a study filter within what the caller can read, never widening it', async () => {
    const narrowed = await authorizeDicomRead(MEMBER, 'Bearer t', '/studies', `?StudyInstanceUID=${OWN},${OTHER}`, deps([OWN]))
    if (narrowed.allowed) expect(new URLSearchParams(narrowed.rewrittenQuery).get('StudyInstanceUID')).toBe(OWN)
    const unreadable = await authorizeDicomRead(MEMBER, 'Bearer t', '/studies', `?StudyInstanceUID=${OTHER}`, deps([OWN]))
    expect(unreadable).toEqual({ allowed: true, emptyResult: true })
  })

  it('answers a study search with nothing when the caller can read no study', async () => {
    const decision = await authorizeDicomRead(MEMBER, 'Bearer t', '/studies', '', deps([]))
    expect(decision).toEqual({ allowed: true, emptyResult: true })
  })

  it('refuses searches below study level that name no study', async () => {
    expect((await authorizeDicomRead(MEMBER, 'Bearer t', '/series', '?Modality=CT', deps([OWN]))).allowed).toBe(false)
    expect((await authorizeDicomRead(MEMBER, 'Bearer t', '/instances', '', deps([OWN]))).allowed).toBe(false)
  })

  it('leaves system grants unrestricted', async () => {
    const system = { sub: 'svc', scope: 'system/*.rs' }
    expect(await authorizeDicomRead(system, 'Bearer t', '/studies', '', deps([]))).toEqual({ allowed: true })
  })

  it('logs instead of refusing in audit-only mode', async () => {
    const decision = await authorizeDicomRead(MEMBER, 'Bearer t', `/studies/${OTHER}`, '', deps([OWN], { mode: () => 'audit-only' }))
    expect(decision).toEqual({ allowed: true })
  })
})

describe('DICOMweb stores', () => {
  beforeEach(clearDicomAccessCache)

  it('lets a member with their own record upload a new study', async () => {
    expect(await authorizeDicomStore(MEMBER, 'Bearer t', '/studies', deps([]))).toEqual({ allowed: true })
  })

  it('refuses an upload from an account with no record of its own', async () => {
    const d = deps([], { callerIdentity: async () => ({ patientId: null, practitioner: false }) })
    expect((await authorizeDicomStore(MEMBER, 'Bearer t', '/studies', d)).allowed).toBe(false)
  })

  it('refuses adding to an existing study the caller cannot read', async () => {
    expect((await authorizeDicomStore(MEMBER, 'Bearer t', `/studies/${OTHER}`, deps([OWN]))).allowed).toBe(false)
    expect(await authorizeDicomStore(MEMBER, 'Bearer t', `/studies/${OWN}`, deps([OWN]))).toEqual({ allowed: true })
  })
})
