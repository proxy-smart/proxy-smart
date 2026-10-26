// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import {
  ADDED_BY_POLICY, actorOf, addedByProvenance, createdRecords, recordAuthorship, signedAdder,
} from '../src/lib/fhir-authorship'
import { isRecord } from '../src/lib/type-guards'

const BASE = 'http://fhir.test/fhir'

describe('createdRecords', () => {
  it('reads a created resource with the version it was created as and the chart it belongs to', () => {
    const body = { resourceType: 'Coverage', id: 'cv1', meta: { versionId: '1' }, beneficiary: { reference: 'Patient/p1' } }
    expect(createdRecords(201, body, undefined)).toEqual([{ type: 'Coverage', id: 'cv1', version: '1', chart: 'Patient/p1' }])
  })

  it('falls back to the Location header when the server answered with no body', () => {
    expect(createdRecords(201, '', `${BASE}/Observation/o1/_history/3`)).toEqual([{ type: 'Observation', id: 'o1', version: '3' }])
  })

  it('ignores updates, and Provenance and AuditEvent, which record the record', () => {
    expect(createdRecords(200, { resourceType: 'Condition', id: 'c1', meta: { versionId: '2' } }, undefined)).toEqual([])
    expect(createdRecords(201, { resourceType: 'Provenance', id: 'p1', meta: { versionId: '1' } }, undefined)).toEqual([])
  })

  it('takes every created entry of a transaction answer', () => {
    const body = {
      resourceType: 'Bundle', type: 'transaction-response',
      entry: [
        { response: { status: '201 Created', location: 'Condition/c1/_history/1' } },
        { response: { status: '200 OK', location: 'Patient/p1/_history/4' } },
        { resource: { resourceType: 'Observation', id: 'o1', meta: { versionId: '1' }, subject: { reference: 'Patient/p1' } }, response: { status: '201 Created' } },
      ],
    }
    expect(createdRecords(200, body, undefined)).toEqual([
      { type: 'Condition', id: 'c1', version: '1' },
      { type: 'Observation', id: 'o1', version: '1', chart: 'Patient/p1' },
    ])
  })
})

describe('actorOf', () => {
  it('is the signed-in user, not the app or the patient in context', () => {
    expect(actorOf({ fhirUser: 'https://fhir.example/Person/m1', patient: 'p1' })).toBe('Person/m1')
    expect(actorOf({ patient: 'p1', azp: 'app' })).toBeUndefined()
  })
})

describe('added-by Provenance', () => {
  it('names the adder, anchors the chart, and signs the creation it is about', async () => {
    const provenance = await addedByProvenance({ type: 'Condition', id: 'c1', version: '1', chart: 'Patient/p1' }, 'Patient/p1')
    expect(provenance).toMatchObject({
      policy: [ADDED_BY_POLICY],
      target: [{ reference: 'Condition/c1/_history/1' }, { reference: 'Patient/p1' }],
      agent: [{ who: { reference: 'Patient/p1' } }],
    })
    expect(await signedAdder(provenance, 'Condition/c1/_history/1')).toBe('Patient/p1')
    expect(await signedAdder(provenance, 'Condition/c2/_history/1')).toBeUndefined()
  })

  it('does not anchor a created Patient to itself', async () => {
    const provenance = await addedByProvenance({ type: 'Patient', id: 'p1', version: '1', chart: 'Patient/p1' }, 'Person/m1')
    expect(provenance.target).toEqual([{ reference: 'Patient/p1/_history/1' }])
  })

  it('proves nothing once its signature is tampered with', async () => {
    const provenance = await addedByProvenance({ type: 'Condition', id: 'c1', version: '1' }, 'Patient/p1')
    const signature = Array.isArray(provenance.signature) ? provenance.signature[0] : undefined
    if (!isRecord(signature)) throw new Error('the Provenance carries no signature')
    const jws = Buffer.from(String(signature.data), 'base64').toString('utf8').split('.')
    const claims = Buffer.from(JSON.stringify({ tgt: 'Condition/c1/_history/1', sub: 'Patient/p2' })).toString('base64url')
    const tampered = { ...provenance, signature: [{ ...signature, data: Buffer.from(`${jws[0]}.${claims}.${jws[2]}`).toString('base64') }] }
    expect(await signedAdder(tampered, 'Condition/c1/_history/1')).toBeUndefined()
  })
})

describe('recordAuthorship', () => {
  function capture() {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    const upstreamFetch = async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 201 })
    }
    return { posts, upstreamFetch }
  }

  it('posts one Provenance for one record, and a transaction for several', async () => {
    const one = capture()
    await recordAuthorship({ created: [{ type: 'Condition', id: 'c1', version: '1' }], tokenPayload: { fhirUser: 'Patient/p1' }, serverUrl: BASE, authHeader: 'Bearer t', upstreamFetch: one.upstreamFetch })
    expect(one.posts).toHaveLength(1)
    expect(one.posts[0].url).toBe(`${BASE}/Provenance`)

    const many = capture()
    await recordAuthorship({
      created: [{ type: 'Condition', id: 'c1', version: '1' }, { type: 'Observation', id: 'o1', version: '1' }],
      tokenPayload: { fhirUser: 'Patient/p1' }, serverUrl: BASE, authHeader: 'Bearer t', upstreamFetch: many.upstreamFetch,
    })
    expect(many.posts[0]).toMatchObject({ url: BASE, body: { resourceType: 'Bundle', type: 'transaction' } })
  })

  it('records nothing for a caller with no signed-in user', async () => {
    const none = capture()
    await recordAuthorship({ created: [{ type: 'Condition', id: 'c1', version: '1' }], tokenPayload: { scope: 'system/*.cruds' }, serverUrl: BASE, authHeader: '', upstreamFetch: none.upstreamFetch })
    expect(none.posts).toHaveLength(0)
  })

  it('leaves the create standing when the Provenance cannot be written', async () => {
    const failing = async () => new Response('nope', { status: 500 })
    await expect(recordAuthorship({ created: [{ type: 'Condition', id: 'c1', version: '1' }], tokenPayload: { fhirUser: 'Patient/p1' }, serverUrl: BASE, authHeader: '', upstreamFetch: failing })).resolves.toBeUndefined()
  })
})
