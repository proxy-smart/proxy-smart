// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Self-access for members whose fhirUser is a Person: reading the Patient their Person links to
 * is their own record, so it needs no Consent, while anything else stays subject to consent.
 */

import { describe, it, expect, afterEach, mock } from 'bun:test'

const personLinks: Record<string, string | undefined> = { 'member-1': 'Patient/patient-123' }

mock.module('../src/lib/consent/person-resolver', () => ({
  resolveFhirUserForClient: async (fhirUser: string, patientFacing: boolean | undefined) => {
    const id = fhirUser.match(/Person\/([^/]+)/)?.[1]
    return patientFacing && id ? personLinks[id] : undefined
  },
  checkIal: async () => ({ allowed: true }),
  getIalConfig: () => ({ enabled: false, cacheTtl: 0 }),
}))

const { checkConsent } = await import('../src/lib/consent/consent-service')

const config = {
  enabled: true,
  mode: 'enforce' as const,
  cacheTtl: 0,
  exemptClients: [],
  requiredForResourceTypes: [],
  exemptResourceTypes: ['CapabilityStatement', 'metadata'],
  appUrl: null,
}

const ORIGINAL_FETCH = globalThis.fetch

function noConsents() {
  globalThis.fetch = Object.assign(
    async () => new Response(JSON.stringify({ resourceType: 'Bundle', entry: [] }), { status: 200 }),
    { preconnect: ORIGINAL_FETCH.preconnect },
  )
}

function token(patient: string) {
  return { sub: 'u', azp: 'patient-portal', fhirUser: 'Person/member-1', patient, scope: 'openid patient/*.rs' }
}

describe('self-access through a Person', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it('needs no Consent for the Patient the Person links to', async () => {
    noConsents()
    const result = await checkConsent(token('patient-123'), 'hapi', 'https://fhir.example.com', 'ImagingStudy', 'GET', 'Bearer t', config)
    expect(result.decision).toBe('permit')
    expect(result.reason).toContain('own record')
  })

  it('stays subject to consent for any other patient', async () => {
    noConsents()
    const result = await checkConsent(token('patient-999'), 'hapi', 'https://fhir.example.com', 'ImagingStudy', 'GET', 'Bearer t', config)
    expect(result.decision).toBe('deny')
  })
})
