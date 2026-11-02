// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import type { Consent, ConsentProvision } from 'fhir/r4'
import { consentRuling, type ConsentOperation, type ConsentRequest } from '../src/lib/consent/provision-rules'
import { r4Provision } from '../src/lib/consent/r4-provision'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const doctor = { role: { coding: [{ code: 'PRCP' }] }, reference: { reference: 'Practitioner/dr-1' } }
const custodian = { role: { coding: [{ code: 'CST' }] }, reference: { reference: 'Organization/max-health' } }
const action = (code: string) => ({ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentaction', code }] })
const resourceClass = (code: string) => ({ system: 'http://hl7.org/fhir/resource-types', code })

const consent = (provision: ConsentProvision): Consent => ({
  resourceType: 'Consent',
  status: 'active',
  scope: { coding: [{ code: 'patient-privacy' }] },
  category: [{ coding: [{ code: '59284-0' }] }],
  provision,
})

const STORED: ConsentProvision[] = [
  { type: 'permit', period: { start: '2026-01-01' }, actor: [doctor], action: [action('access')], class: [resourceClass('Observation')] },
  { type: 'permit', actor: [custodian] },
  { type: 'permit', actor: [doctor], provision: [{ type: 'deny', class: [resourceClass('Condition')] }] },
  { type: 'deny', provision: [{ type: 'permit', actor: [doctor], action: [action('disclose')] }] },
]

const REQUESTS: Partial<ConsentRequest>[] = (['read', 'add', 'change'] as const).flatMap((operation: ConsentOperation) =>
  ['Observation', 'Condition', null].flatMap((resourceType) => [
    { operation, resourceType },
    { operation, resourceType, fhirUser: 'Practitioner/dr-2' },
    { operation, resourceType, fhirUser: null, organizations: new Set(['max-health']) },
  ]))

const request = (overrides: Partial<ConsentRequest>): ConsentRequest => ({
  clientId: 'viewer',
  fhirUser: 'Practitioner/dr-1',
  organizations: new Set(),
  resourceType: 'Observation',
  operation: 'read',
  serverUrl: 'https://fhir.example/fhir',
  ...overrides,
})

describe('r4Provision', () => {
  it('leaves a rule tree that is already R4 alone', () => {
    expect(r4Provision({ actor: [doctor], provision: [{ type: 'permit' }] })).toBeNull()
  })

  it('moves the typed root down under its conditions', () => {
    expect(r4Provision({ type: 'permit', actor: [custodian] })).toEqual({ actor: [custodian], provision: [{ type: 'permit' }] })
  })

  it('decides every request the way the stored Consent did', () => {
    for (const stored of STORED) {
      const migrated = r4Provision(stored)
      expect(migrated?.type).toBeUndefined()
      for (const overrides of REQUESTS) {
        const before = consentRuling(consent(stored), request(overrides), NOW)
        const after = migrated && consentRuling(consent(migrated), request(overrides), NOW)
        expect({ stored, overrides, ruling: after }).toEqual({ stored, overrides, ruling: before })
      }
    }
  })
})
