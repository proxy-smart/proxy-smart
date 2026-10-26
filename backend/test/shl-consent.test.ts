// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SHL → Consent mirror: the built resource must conform to the
 * MaxHealthShareConsent profile so active SHLs surface correctly in the
 * consent portal.
 */
import { describe, it, expect } from 'bun:test'
import { validateMaxHealthShareConsent } from '@proxy-smart/consent-fhir'
import { MaxHealthConsentCategoryVSConcepts } from '@proxy-smart/consent-fhir/valuesets/ValueSet-MaxHealthConsentCategoryVS'
import {
  buildShareConsent,
  SHL_CONSENT_IDENTIFIER_SYSTEM,
  SHL_CONSENT_CATEGORY_SYSTEM,
  SHL_CONSENT_CATEGORY_CODE,
} from '../src/lib/consent/shl-consent'
import { buildShlAccessAuditEvent } from '../src/lib/consent/shl-audit'
import type { ShlSession } from '../src/lib/shl/session-store'

function makeSession(overrides: Partial<ShlSession> = {}): ShlSession {
  return {
    shl: { url: 'https://example.test/shl', key: 'k', label: 'Dr. Smith' },
    jwe: 'jwe',
    sessionToken: 'tok',
    patientId: 'patient-123',
    fhirServerUrl: 'https://fhir.test/fhir',
    expiresAt: Date.now() + 60 * 60 * 1000,
    verifiedOnly: false,
    accessCount: 0,
    ...overrides,
  }
}

describe('buildShareConsent', () => {
  it('records a read-only share as access alone', () => {
    const consent = buildShareConsent('shl-read', makeSession())
    const codes = consent.provision?.action?.flatMap((a) => a.coding?.map((c) => c.code) ?? []) ?? []
    expect(codes).toEqual(['access'])
  })

  it('records a write-enabled share as access AND correct', () => {
    // Without the second code an upload-capable link mirrors as a read-only grant,
    // and the consent portal is where the patient reviews what they gave away.
    const consent = buildShareConsent('shl-write', makeSession({ writeScope: { dicom: true } }))
    const codes = consent.provision?.action?.flatMap((a) => a.coding?.map((c) => c.code) ?? []) ?? []
    expect(codes).toEqual(['access', 'correct'])
  })

  it('names the intended recipient while still saying it is a bearer link', () => {
    const consent = buildShareConsent('shl-named', makeSession({ recipientName: 'Dr. Müller' }))
    const display = consent.provision?.actor?.[0]?.reference?.display ?? ''
    expect(display).toContain('Dr. Müller')
    expect(display).toContain('holder of the share link')
  })

  it('produces a profile-valid, active, permit Consent tied to the SHL id', async () => {
    const consent = buildShareConsent('shl-abc', makeSession())

    expect(consent.resourceType).toBe('Consent')
    expect(consent.status).toBe('active')
    expect(consent.provision?.type).toBe('permit')
    expect(consent.identifier?.[0]).toEqual({ system: SHL_CONSENT_IDENTIFIER_SYSTEM, value: 'shl-abc' })
    expect(consent.patient?.reference).toBe('Patient/patient-123')
    expect(consent.provision?.period?.end).toBeString()

    const { errors } = await validateMaxHealthShareConsent(consent)
    expect(errors).toEqual([])
  })

  it('maps period.end to the SHL expiry', () => {
    const expiresAt = Date.parse('2030-01-01T00:00:00.000Z')
    const consent = buildShareConsent('shl-x', makeSession({ expiresAt }))
    expect(consent.provision?.period?.end).toBe(new Date(expiresAt).toISOString())
  })

  it('scopes provision.class to ImagingStudy for a study-scoped share', () => {
    const consent = buildShareConsent('shl-study', makeSession({ studyInstanceUID: '1.2.3' }))
    const codes = consent.provision?.class?.map((c) => c.code)
    expect(codes).toEqual(['ImagingStudy'])
  })

  it('omits provision.class for a whole-patient share (no fabricated type list)', () => {
    const consent = buildShareConsent(
      'shl-whole',
      makeSession({ shareScope: { excludedTypes: ['Condition'], excludedIds: [], excludedObservationCategories: [] } }),
    )
    // Empty class = all resources; the SHL proxy scope filter enforces exclusions.
    expect(consent.provision?.class).toBeUndefined()
  })

  it('carries no named recipient — actor is the anonymous link-holder grantee', () => {
    const consent = buildShareConsent('shl-anon', makeSession({ shl: { url: 'u', key: 'k' } }))
    const actor = consent.provision?.actor?.[0]
    expect(actor?.role?.coding?.[0]?.code).toBe('IRCP')
    expect(actor?.reference?.reference).toBeUndefined()
    expect(actor?.reference?.display).toBe('Any holder of the share link')
  })

  it('categorises the share with LOINC 59284-0, not consentcategorycodes', () => {
    const consent = buildShareConsent('shl-loinc', makeSession())
    const codings = consent.category?.flatMap((c) => c.coding ?? []) ?? []
    expect(codings).toContainEqual({ system: 'http://loinc.org', code: '59284-0', display: 'Consent Document' })
    expect(codings.some((c) => c.system === 'http://terminology.hl7.org/CodeSystem/consentcategorycodes')).toBe(false)
  })

  it('pins the identifier system revocation matches on', () => {
    expect(SHL_CONSENT_IDENTIFIER_SYSTEM).toBe('https://maxhealth.tech/fhir/shl-session')
  })

  it('tags the consent as a SMART Health Link share for UI detection', () => {
    const consent = buildShareConsent('shl-cat', makeSession())
    const codes = consent.category?.flatMap((c) => c.coding?.map((x) => x.code) ?? []) ?? []
    expect(codes).toContain(SHL_CONSENT_CATEGORY_CODE)
  })
})

/** Revocation matches the identifier system exactly, so these hold the wire values to the IG. */
describe('share consent conforms to the IG terminology', () => {
  it('sources the category coding from the IG ValueSet', () => {
    expect(SHL_CONSENT_CATEGORY_SYSTEM).toBe(MaxHealthConsentCategoryVSConcepts[0].system)
    expect(SHL_CONSENT_CATEGORY_CODE).toBe(MaxHealthConsentCategoryVSConcepts[0].code)
  })

  it('rejects a drifted identifier system', async () => {
    const consent = buildShareConsent('shl-abc', makeSession())
    consent.identifier = [{ system: 'https://wrong.example/shl-session', value: 'shl-abc' }]

    const { errors } = await validateMaxHealthShareConsent(consent)
    expect(errors.join(' ')).toContain('identifier:shlSession')
  })

  it('rejects a share that is missing the share-marker category', async () => {
    const consent = buildShareConsent('shl-abc', makeSession())
    // Only the ordinary consent category — no SHL marker.
    consent.category = [{ coding: [{ system: 'http://loinc.org', code: '57016-8' }] }]

    const { errors } = await validateMaxHealthShareConsent(consent)
    expect(errors.join(' ')).toContain('category:shareMarker')
  })
})

describe('buildShlAccessAuditEvent', () => {
  it('records a read access attributing the recipient and the SHL entity', () => {
    const audit = buildShlAccessAuditEvent({
      shlId: 'shl-a',
      session: makeSession(),
      recipient: 'Dr. Jones',
      ipAddress: '203.0.113.5',
    })
    expect(audit.resourceType).toBe('AuditEvent')
    expect(audit.action).toBe('R')
    expect(audit.agent[0]?.who?.display).toBe('Dr. Jones')
    expect(audit.agent[0]?.network?.address).toBe('203.0.113.5')
    const shlEntity = audit.entity?.find((e) => e.what?.identifier?.value === 'shl-a')
    expect(shlEntity).toBeDefined()
  })

  it('falls back to an anonymous recipient when none is supplied', () => {
    const audit = buildShlAccessAuditEvent({ shlId: 'shl-b', session: makeSession() })
    expect(audit.agent[0]?.who?.display).toBe('Anonymous share-link recipient')
  })
})
