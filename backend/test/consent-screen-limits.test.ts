// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { fakeFetch } from './helpers/fake-fetch'
import { useTestEnv, applyEnv } from './helpers/test-env'
import { consentCache } from '../src/lib/consent/consent-cache'
import { executeFhirRequest, type FhirTarget } from '../src/lib/fhir-request-pipeline'
import { isRecord } from '../src/lib/type-guards'

const UPSTREAM = 'http://fhir.test/fhir'
const originalFetch = globalThis.fetch
const upstreamUrls: string[] = []

type UpstreamAnswer = { body: string; contentType: string }
let upstreamAnswer: (url: string) => UpstreamAnswer

const json = (body: unknown): UpstreamAnswer => ({ body: JSON.stringify(body), contentType: 'application/fhir+json' })
const observation = (patient: string, id = `obs-${patient}`) => ({ resourceType: 'Observation', id, code: { text: 'x' }, subject: { reference: `Patient/${patient}` } })
const searchset = (entry: unknown[], extra: Record<string, unknown> = {}) => ({ resourceType: 'Bundle', type: 'searchset', entry, ...extra })

const target: FhirTarget = {
  serverInfo: { name: 'hapi', url: UPSTREAM, identifier: 'consent-limits', lastUpdated: 0, metadata: { fhirVersion: '4.0.1', supported: true } },
  serverName: 'hapi',
  fhirVersion: 'R4',
  upstreamFetch: async (url: string) => {
    upstreamUrls.push(url)
    const answer = upstreamAnswer(url)
    return new Response(answer.body, { status: 200, headers: { 'content-type': answer.contentType } })
  },
}

const practitioner = { tokenPayload: { sub: 'viewer', scope: 'openid user/*.rs', fhirUser: 'Practitioner/dr-1', aud: UPSTREAM }, authHeader: 'Bearer t' }

function search(resourcePath: string, queryString = '') {
  return executeFhirRequest(target, practitioner, { method: 'GET', resourcePath, queryString, headers: new Headers() })
}

function entryIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.entry)) throw new Error('not a bundle')
  return body.entry.map((e: { resource: { id: string } }) => e.resource.id)
}

function issueCode(body: unknown): unknown {
  return isRecord(body) && body.resourceType === 'OperationOutcome' && Array.isArray(body.issue) && isRecord(body.issue[0]) ? body.issue[0].code : undefined
}

describe('consent screening of reads without a patient context', () => {
  useTestEnv({ CONSENT_ENABLED: 'true', CONSENT_MODE: 'enforce' })

  beforeEach(() => {
    consentCache.clear()
    upstreamUrls.length = 0
    upstreamAnswer = () => json(searchset([{ resource: observation('consented') }, { resource: observation('other') }]))
    globalThis.fetch = fakeFetch((url) => {
      const patient = new URL(url).searchParams.get('patient')
      const permit = { resourceType: 'Consent', id: 'c1', status: 'active', provision: { type: 'permit', actor: [{ role: { coding: [{ code: 'GRANTEE' }] }, reference: { reference: 'Organization/viewer' } }] } }
      const entry = patient === 'Patient/consented' ? [{ resource: permit }] : []
      return new Response(JSON.stringify(searchset(entry)), { status: 200, headers: { 'content-type': 'application/fhir+json' } })
    })
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it.serial('keeps only consented patients\' records in a search with no patient parameter', async () => {
    const result = await search('Observation', '?code=x')
    expect(result.status).toBe(200)
    expect(entryIds(result.body)).toEqual(['obs-consented'])
  })

  it.serial('refuses a single record of a patient who has not consented', async () => {
    upstreamAnswer = () => json(observation('other'))
    expect((await search('Observation/obs-other')).status).toBe(403)
  })

  it.serial('takes included records of a patient who has not consented out of the answer', async () => {
    upstreamAnswer = () => json(searchset([
      { resource: observation('consented') },
      { resource: { resourceType: 'Patient', id: 'other' }, search: { mode: 'include' } },
    ]))
    const result = await search('Observation', '?_include=Observation:subject')
    expect(entryIds(result.body)).toEqual(['obs-consented'])
  })

  it.serial('refuses _summary=count, which cannot be screened, without asking upstream', async () => {
    const result = await search('Observation', '?_summary=count')
    expect(result.status).toBe(403)
    expect(issueCode(result.body)).toBe('forbidden')
    expect(upstreamUrls).toEqual([])
  })

  it.serial('refuses _summary=text, whose answer drops the patient reference', async () => {
    expect((await search('Observation', '?_summary=text')).status).toBe(403)
    expect(upstreamUrls).toEqual([])
  })

  it.serial('keeps the patient reference in an _elements answer so it can be screened', async () => {
    const result = await search('Observation', '?_elements=code')
    expect(result.status).toBe(200)
    const elements = new URL(upstreamUrls[0] ?? '').searchParams.get('_elements')?.split(',') ?? []
    expect(elements).toContain('code')
    expect(elements).toContain('subject')
    expect(entryIds(result.body)).toEqual(['obs-consented'])
  })

  it.serial('refuses _elements together with _include, which it cannot keep screenable', async () => {
    expect((await search('Observation', '?_elements=code&_include=Observation:subject')).status).toBe(403)
    expect(upstreamUrls).toEqual([])
  })

  it.serial('refuses an answer it cannot read to screen', async () => {
    upstreamAnswer = () => ({ body: '<Bundle xmlns="http://hl7.org/fhir"/>', contentType: 'application/fhir+xml' })
    const result = await search('Observation', '?_format=xml')
    expect(result.status).toBe(406)
    expect(issueCode(result.body)).toBe('not-supported')
  })

  it.serial('drops a total that counted records taken out of the answer', async () => {
    upstreamAnswer = () => json(searchset([{ resource: observation('consented') }, { resource: observation('other') }], { total: 2 }))
    const result = await search('Observation')
    expect(isRecord(result.body) && 'total' in result.body).toBe(false)
  })

  it.serial('drops a total that counts pages not yet screened', async () => {
    upstreamAnswer = () => json(searchset([{ resource: observation('consented') }], { total: 40, link: [{ relation: 'next', url: `${UPSTREAM}?_getpages=abc` }] }))
    const result = await search('Observation')
    expect(isRecord(result.body) && 'total' in result.body).toBe(false)
  })

  it.serial('keeps a total the screened answer fully accounts for', async () => {
    upstreamAnswer = () => json(searchset([{ resource: observation('consented') }], { total: 1 }))
    const result = await search('Observation')
    expect(isRecord(result.body) ? result.body.total : undefined).toBe(1)
  })

  it.serial('leaves types outside the patient compartment alone', async () => {
    upstreamAnswer = () => json(searchset([{ resource: { resourceType: 'Organization', id: 'o' } }], { total: 9 }))
    expect((await search('Organization', '?_summary=count')).status).toBe(200)
  })

  it.serial('only logs in audit-only mode', async () => {
    applyEnv({ CONSENT_MODE: 'audit-only' })
    expect((await search('Observation', '?_summary=count')).status).toBe(200)
    expect(upstreamUrls[0]).toContain('_summary=count')
    upstreamAnswer = () => json(searchset([{ resource: observation('other') }], { total: 1 }))
    const result = await search('Observation', '?_elements=code')
    expect(new URL(upstreamUrls[1] ?? '').searchParams.get('_elements')).toBe('code')
    expect(entryIds(result.body)).toEqual(['obs-other'])
  })
})
