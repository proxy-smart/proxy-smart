// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import type { Consent, ConsentProvision, ConsentProvisionActor, Reference } from 'fhir/r4'
import type { Consent as ConsentR5 } from 'fhir/r5'
import { consentRuling, isConsentRead, periodCovers, type ConsentRequest } from '../src/lib/consent/provision-rules'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const ACTION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/consentaction'

const request = (overrides: Partial<ConsentRequest> = {}): ConsentRequest => ({
  clientId: 'viewer',
  fhirUser: 'Practitioner/dr-1',
  resourceType: 'Observation',
  read: true,
  serverUrl: 'https://fhir.example/fhir',
  ...overrides,
})

const consent = (provision: ConsentProvision, extra: Partial<Consent> = {}): Consent => ({
  resourceType: 'Consent',
  id: 'c1',
  status: 'active',
  scope: { coding: [{ code: 'patient-privacy' }] },
  category: [{ coding: [{ code: '59284-0' }] }],
  ...extra,
  provision,
})

const r5Consent = (extra: Partial<ConsentR5>): ConsentR5 => ({ resourceType: 'Consent', id: 'c5', status: 'active', ...extra })

const named = (reference: Reference): ConsentProvisionActor => ({ role: { coding: [{ code: 'PRCP' }] }, reference })
const toDoctor = named({ reference: 'Practitioner/dr-1' })
const action = (code: string) => ({ coding: [{ system: ACTION_SYSTEM, code }] })
const resourceClass = (code: string) => ({ system: 'http://hl7.org/fhir/resource-types', code })

describe('periodCovers', () => {
  it('treats a date-only end as lasting through that whole day', () => {
    expect(periodCovers({ start: '2026-10-01', end: '2026-10-30' }, NOW)).toBe('covers')
    expect(periodCovers({ end: '2026-10-29' }, NOW)).toBe('outside')
  })

  it('reads year and year-month precision as their full span', () => {
    expect(periodCovers({ start: '2026', end: '2026' }, NOW)).toBe('covers')
    expect(periodCovers({ end: '2026-09' }, NOW)).toBe('outside')
    expect(periodCovers({ start: '2026-11' }, NOW)).toBe('outside')
  })

  it('compares instants exactly', () => {
    expect(periodCovers({ end: '2026-10-30T11:59:59Z' }, NOW)).toBe('outside')
    expect(periodCovers({ start: '2026-10-30T12:00:00+01:00' }, NOW)).toBe('covers')
  })

  it('reports a bound it cannot read', () => {
    expect(periodCovers({ end: 'next tuesday' }, NOW)).toBe('invalid')
    expect(periodCovers({ start: '2026-13-01' }, NOW)).toBe('invalid')
  })

  it('treats a missing period as always in force', () => {
    expect(periodCovers(undefined, NOW)).toBe('covers')
  })
})

describe('consentRuling', () => {
  it('permits what the org writers produce: a typed root rule naming the requester', () => {
    const grant = consent({
      type: 'permit',
      period: { start: '2026-10-01', end: '2026-10-30' },
      actor: [toDoctor],
      action: [action('access')],
      class: [resourceClass('Observation')],
    })
    expect(consentRuling(grant, request(), NOW)).toBe('permit')
  })

  it('lets a nested deny take a resource type back out of a permit', () => {
    const grant = consent({
      type: 'permit',
      actor: [toDoctor],
      provision: [{ type: 'deny', class: [resourceClass('Observation')] }],
    })
    expect(consentRuling(grant, request(), NOW)).toBe('deny')
    expect(consentRuling(grant, request({ resourceType: 'Condition' }), NOW)).toBe('permit')
  })

  it('reads an untyped root as the base policy and its nested rules as the decision', () => {
    const grant = consent({
      provision: [
        { type: 'permit', actor: [toDoctor], class: [resourceClass('Condition')] },
        { type: 'deny', actor: [toDoctor], class: [resourceClass('Observation')] },
      ],
    })
    expect(consentRuling(grant, request({ resourceType: 'Condition' }), NOW)).toBe('permit')
    expect(consentRuling(grant, request(), NOW)).toBe('deny')
    expect(consentRuling(grant, request({ resourceType: 'Encounter' }), NOW)).toBeNull()
  })

  it('lets a deny sibling win over a permit sibling', () => {
    const grant = consent({
      actor: [toDoctor],
      provision: [{ type: 'permit' }, { type: 'deny' }],
    })
    expect(consentRuling(grant, request(), NOW)).toBe('deny')
  })

  it('grants nothing when no rule on the path names the requester', () => {
    expect(consentRuling(consent({ type: 'permit' }), request(), NOW)).toBeNull()
    expect(consentRuling(consent({ type: 'permit', actor: [named({ display: 'Any holder' })] }), request(), NOW)).toBeNull()
  })

  it('applies an actor-less deny to everyone', () => {
    const grant = consent({ type: 'permit', actor: [toDoctor], provision: [{ type: 'deny' }] })
    expect(consentRuling(grant, request(), NOW)).toBe('deny')
  })

  it('matches actors exactly, not by substring', () => {
    const grant = consent({ type: 'permit', actor: [named({ reference: 'Organization/viewer-admin' })] })
    expect(consentRuling(grant, request({ fhirUser: null }), NOW)).toBeNull()
    const own = consent({ type: 'permit', actor: [named({ reference: 'Organization/viewer' })] })
    expect(consentRuling(own, request({ fhirUser: null }), NOW)).toBe('permit')
    const lookalike = consent({ type: 'permit', actor: [named({ reference: 'Practitioner/dr-10' })] })
    expect(consentRuling(lookalike, request(), NOW)).toBeNull()
  })

  it('names a client by Device reference or identifier, and a user by absolute reference', () => {
    const device = consent({ type: 'permit', actor: [named({ reference: 'Device/viewer' })] })
    expect(consentRuling(device, request({ fhirUser: null }), NOW)).toBe('permit')
    const identifier = consent({ type: 'permit', actor: [named({ identifier: { value: 'viewer' } })] })
    expect(consentRuling(identifier, request({ fhirUser: null }), NOW)).toBe('permit')
    const absolute = consent({ type: 'permit', actor: [named({ reference: 'https://fhir.example/fhir/Practitioner/dr-1' })] })
    expect(consentRuling(absolute, request(), NOW)).toBe('permit')
  })

  it('honours the actions a rule lists', () => {
    const access = consent({ type: 'permit', actor: [toDoctor], action: [action('access')] })
    expect(consentRuling(access, request(), NOW)).toBe('permit')
    expect(consentRuling(access, request({ read: false }), NOW)).toBeNull()
    const correct = consent({ type: 'permit', actor: [toDoctor], action: [action('correct')] })
    expect(consentRuling(correct, request({ read: false }), NOW)).toBe('permit')
    const disclose = consent({ type: 'permit', actor: [toDoctor], action: [action('disclose')] })
    expect(consentRuling(disclose, request(), NOW)).toBe('permit')
  })

  it('keeps a class-limited permit away from requests whose type is unknown, but applies a class-limited deny', () => {
    const permit = consent({ type: 'permit', actor: [toDoctor], class: [resourceClass('Observation')] })
    expect(consentRuling(permit, request({ resourceType: null }), NOW)).toBeNull()
    const deny = consent({ type: 'permit', actor: [toDoctor], provision: [{ type: 'deny', class: [resourceClass('Observation')] }] })
    expect(consentRuling(deny, request({ resourceType: null }), NOW)).toBe('deny')
  })

  it('ignores rules outside their period and denies on a period it cannot read', () => {
    const expired = consent({ type: 'permit', actor: [toDoctor], period: { end: '2026-10-29' } })
    expect(consentRuling(expired, request(), NOW)).toBeNull()
    const garbled = consent({ type: 'permit', actor: [toDoctor], period: { end: 'soon' } })
    expect(consentRuling(garbled, request(), NOW)).toBe('deny')
  })

  it('ignores consents that are not active', () => {
    expect(consentRuling(consent({ type: 'permit', actor: [toDoctor] }, { status: 'inactive' }), request(), NOW)).toBeNull()
  })

  it('denies on a Consent shape it does not evaluate', () => {
    expect(consentRuling(r5Consent({ provision: [{ actor: [{ reference: { reference: 'Practitioner/dr-1' } }] }] }), request(), NOW)).toBe('deny')
    expect(consentRuling(r5Consent({ decision: 'permit', provision: [{ actor: [{ reference: { reference: 'Practitioner/dr-1' } }] }] }), request(), NOW)).toBe('deny')
  })
})

describe('isConsentRead', () => {
  it('counts searches and operations as reads', () => {
    expect(isConsentRead('GET', 'Observation')).toBe(true)
    expect(isConsentRead('POST', 'Observation/_search')).toBe(true)
    expect(isConsentRead('POST', 'Patient/p1/$everything')).toBe(true)
    expect(isConsentRead('PUT', 'Observation/o1')).toBe(false)
  })
})
