// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { Consent } from 'fhir/r4'
import { fakeFetch, jsonResponse } from './helpers/fake-fetch'
import { makeConsentConfig } from './helpers/consent'

mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => null,
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

const { addedByProvenance } = await import('../src/lib/fhir-authorship')
const { checkConsent } = await import('../src/lib/consent/consent-service')
const { consentCache } = await import('../src/lib/consent/consent-cache')

const BASE = 'http://fhir.test/fhir'
const ACTION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/consentaction'
const CONFIG = makeConsentConfig()
const originalFetch = globalThis.fetch

function grant(...actions: string[]): Consent {
  return {
    resourceType: 'Consent',
    id: 'grant-1',
    status: 'active',
    scope: { coding: [{ code: 'patient-privacy' }] },
    category: [{ coding: [{ code: '59284-0' }] }],
    patient: { reference: 'Patient/p1' },
    provision: {
      type: 'permit',
      actor: [{ role: { coding: [{ code: 'PRCP' }] }, reference: { reference: 'Practitioner/dr-1' } }],
      action: actions.map((code) => ({ coding: [{ system: ACTION_SYSTEM, code }] })),
    },
  }
}

const person = (linked: string) => ({ resourceType: 'Person', id: 'x', link: [{ target: { reference: linked }, assurance: 'level3' }] })

async function serve(consent: Consent, adder: string): Promise<void> {
  const provenance = await addedByProvenance({ type: 'ImagingStudy', id: 's1', version: '1', chart: 'Patient/p1' }, adder)
  globalThis.fetch = fakeFetch((url) => {
    const path = url.slice(BASE.length + 1)
    if (path.startsWith('Consent?')) return jsonResponse({ resourceType: 'Bundle', entry: [{ resource: consent }] })
    if (path.startsWith('ImagingStudy/s1/_history')) {
      return jsonResponse({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'ImagingStudy', id: 's1', meta: { versionId: '1' } } }] })
    }
    if (path.startsWith('Provenance?')) return jsonResponse({ resourceType: 'Bundle', entry: [{ resource: provenance }] })
    if (path === 'Person/clinician') return jsonResponse(person('Practitioner/dr-1'))
    if (path === 'Person/patient') return jsonResponse(person('Patient/p9'))
    return jsonResponse({}, 404)
  })
}

async function decide(method: string, path: string, fhirUser = 'Practitioner/dr-1'): Promise<string> {
  const token = { sub: 'kc-dr-1', azp: 'viewer', scope: 'user/*.cruds', patient: 'p1', fhirUser }
  const { decision } = await checkConsent(token, 'test', BASE, path, method, 'Bearer t', CONFIG)
  return decision
}

describe('a grant to add records', () => {
  beforeEach(() => consentCache.clear())
  afterEach(() => {
    globalThis.fetch = originalFetch
    consentCache.clear()
  })

  it.serial('lets the grantee add a record but not change one someone else added', async () => {
    await serve(grant('access', 'collect'), 'Practitioner/dr-2')
    expect(await decide('POST', 'ImagingStudy')).toBe('permit')
    expect(await decide('PUT', 'ImagingStudy/s1')).toBe('deny')
  })

  it.serial('lets the grantee change a record they added themselves', async () => {
    await serve(grant('access', 'collect'), 'Practitioner/dr-1')
    expect(await decide('PUT', 'ImagingStudy/s1')).toBe('permit')
  })

  it.serial('does not let a read-only grantee change even their own record', async () => {
    await serve(grant('access'), 'Practitioner/dr-1')
    expect(await decide('POST', 'ImagingStudy')).toBe('deny')
    expect(await decide('PUT', 'ImagingStudy/s1')).toBe('deny')
  })

  it.serial('names a clinician who signs in as a Person by the Practitioner it links to', async () => {
    await serve(grant('access'), 'Practitioner/dr-2')
    expect(await decide('GET', 'ImagingStudy/s1', 'Person/clinician')).toBe('permit')
    expect(await decide('GET', 'ImagingStudy/s1', 'Person/patient')).toBe('deny')
  })
})
