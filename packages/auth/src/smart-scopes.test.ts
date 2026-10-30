// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART scope predicate tests.
 *
 * The patient-compartment cases pin the SMART App Launch 2.2 obligation quoted in
 * smart-scopes.ts: granting a `patient/` scope means the authorization server
 * SHALL establish a patient in context. We take the spec's "MAY infer the
 * launch/patient scope" branch, so these predicates must treat a `patient/`
 * scope exactly like an explicit launch/patient request.
 */
import { describe, expect, it } from 'bun:test'
import {
  canReturnFhirUser,
  hasSystemScope,
  isSystemScope,
  canReturnPatient,
  hasPatientCompartmentScope,
  hasUserLevelScope,
  isSmartLaunch,
  isStandaloneLaunch,
  parseScopes,
  parseTokenScopes,
} from './smart-scopes'

describe('hasPatientCompartmentScope', () => {
  it('detects patient-restricted resource scopes in v1 and v2 syntax', () => {
    expect(hasPatientCompartmentScope(parseScopes('patient/Observation.rs'))).toBe(true)
    expect(hasPatientCompartmentScope(parseScopes('patient/*.read'))).toBe(true)
    expect(hasPatientCompartmentScope(parseScopes('patient/Patient.*'))).toBe(true)
    expect(hasPatientCompartmentScope(parseScopes('openid fhirUser patient/Condition.cruds'))).toBe(true)
  })

  it('treats a scope constrained by search parameters as patient-restricted too', () => {
    const lab = 'patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory'
    expect(hasPatientCompartmentScope(parseScopes(lab))).toBe(true)
    expect(hasUserLevelScope(parseScopes('user/Condition.rs?category=problem-list-item'))).toBe(true)
  })

  it('ignores scopes for other compartments', () => {
    expect(hasPatientCompartmentScope(parseScopes('user/Observation.rs system/*.rs agent/Patient.rs'))).toBe(false)
  })

  it('does not confuse the launch/patient context scope for a resource scope', () => {
    expect(hasPatientCompartmentScope(parseScopes('launch/patient'))).toBe(false)
  })

  it('ignores unrelated scopes', () => {
    expect(hasPatientCompartmentScope(parseScopes('openid profile email offline_access'))).toBe(false)
    expect(hasPatientCompartmentScope(parseScopes(''))).toBe(false)
  })
})

describe('isSmartLaunch', () => {
  it('is true for the explicit launch scopes', () => {
    expect(isSmartLaunch(parseScopes('launch'))).toBe(true)
    expect(isSmartLaunch(parseScopes('launch/patient'))).toBe(true)
    expect(isSmartLaunch(parseScopes('launch/encounter'))).toBe(true)
  })

  it('is true for a patient-restricted scope with no launch scope at all', () => {
    // Without this the callback is never intercepted, so no context is
    // established and the SHALL is unmet.
    expect(isSmartLaunch(parseScopes('openid fhirUser patient/Observation.rs'))).toBe(true)
  })

  it('is false for scopes that carry no patient-context obligation', () => {
    expect(isSmartLaunch(parseScopes('openid fhirUser user/Observation.rs'))).toBe(false)
    expect(isSmartLaunch(parseScopes('system/Observation.rs'))).toBe(false)
  })
})

describe('isStandaloneLaunch', () => {
  it('is true for launch/patient without an EHR launch code', () => {
    expect(isStandaloneLaunch(parseScopes('launch/patient'), false)).toBe(true)
  })

  it('is true for a patient/ scope without an EHR launch code', () => {
    // The picker is what establishes context in this case.
    expect(isStandaloneLaunch(parseScopes('patient/Observation.rs'), false)).toBe(true)
  })

  it('is false when an EHR launch code supplies the context', () => {
    expect(isStandaloneLaunch(parseScopes('patient/Observation.rs'), true)).toBe(false)
    expect(isStandaloneLaunch(parseScopes('launch/patient'), true)).toBe(false)
  })

  it('is false for non-patient compartments', () => {
    expect(isStandaloneLaunch(parseScopes('user/Observation.rs'), false)).toBe(false)
  })
})

describe('canReturnPatient', () => {
  it('allows patient context for the explicit launch scopes', () => {
    expect(canReturnPatient(parseScopes('launch'))).toBe(true)
    expect(canReturnPatient(parseScopes('launch/patient'))).toBe(true)
  })

  it('allows patient context for a patient-restricted grant', () => {
    // Established context must reach the app, or it cannot stay inside the
    // compartment its own grant is limited to.
    expect(canReturnPatient(parseScopes('patient/Observation.rs'))).toBe(true)
  })

  it('withholds patient context when nothing requested it', () => {
    expect(canReturnPatient(parseScopes('openid fhirUser user/*.rs'))).toBe(false)
  })
})

describe('parseTokenScopes', () => {
  it('reads the space-separated scope claim of a token payload', () => {
    expect(parseTokenScopes({ scope: 'openid  patient/*.rs' })).toEqual(new Set(['openid', 'patient/*.rs']))
  })

  it('grants nothing for a missing or non-string scope claim', () => {
    expect(parseTokenScopes({}).size).toBe(0)
    expect(parseTokenScopes({ scope: ['patient/*.rs'] }).size).toBe(0)
  })
})

describe('canReturnFhirUser', () => {
  it('needs both openid and fhirUser, as SMART pairs them', () => {
    expect(canReturnFhirUser(parseScopes('openid fhirUser'))).toBe(true)
    expect(canReturnFhirUser(parseScopes('openid profile'))).toBe(false)
    expect(canReturnFhirUser(parseScopes('fhirUser'))).toBe(false)
    expect(canReturnFhirUser(parseScopes('openidx fhirUserx'))).toBe(false)
  })
})

describe('system scopes', () => {
  it('recognises a system-level scope and a set holding one', () => {
    expect(isSystemScope('system/*.rs')).toBe(true)
    expect(isSystemScope('user/*.rs')).toBe(false)
    expect(hasSystemScope(['openid', 'system/Patient.rs'])).toBe(true)
    expect(hasSystemScope(new Set(['openid', 'patient/*.rs']))).toBe(false)
  })
})
