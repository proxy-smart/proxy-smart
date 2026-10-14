// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** The REQUEST decides where it can; the human decides where it cannot. Nothing guesses. */
import { describe, test, expect } from 'bun:test'
import { chooseIdentity, candidatesForScopes, isOfferedIdentity, type IdentityCandidate } from './identity-choice'

const patient: IdentityCandidate = { reference: 'Patient/1', resourceType: 'Patient', display: 'Max N' }
const practitioner: IdentityCandidate = { reference: 'Practitioner/2', resourceType: 'Practitioner', display: 'Dr N' }
const related: IdentityCandidate = { reference: 'RelatedPerson/3', resourceType: 'RelatedPerson' }

describe('candidatesForScopes', () => {
  test('a standalone patient-context launch can only be satisfied by a Patient', () => {
    expect(candidatesForScopes([patient, practitioner], 'launch/patient openid')).toEqual([patient])
    expect(candidatesForScopes([patient, practitioner], 'patient/Observation.rs')).toEqual([patient])
  })

  test('an EHR launch is NOT narrowed, because the patient is somebody else', () => {
    expect(candidatesForScopes([patient, practitioner], 'launch openid'))
      .toEqual([patient, practitioner])
  })

  test('a launch code in context means the context was not established here', () => {
    expect(candidatesForScopes([patient, practitioner], 'launch/patient', { patientContextEstablished: true }))
      .toEqual([patient, practitioner])
  })

  test('a request that asked for no patient context keeps every candidate', () => {
    expect(candidatesForScopes([patient, practitioner], 'user/Patient.rs openid'))
      .toEqual([patient, practitioner])
  })

  test('an EHR launch takes the Practitioner, because that is what the launch means', () => {
    expect(candidatesForScopes([patient, practitioner], 'launch openid', { ehrLaunch: true }))
      .toEqual([practitioner])
  })

  test('an EHR launch by someone with no Practitioner keeps every candidate', () => {
    expect(candidatesForScopes([patient], 'launch openid', { ehrLaunch: true })).toEqual([patient])
  })

  test('keeps everything when patient context is wanted but no Patient exists', () => {
    expect(candidatesForScopes([practitioner, related], 'launch/patient')).toEqual([practitioner, related])
  })
})

describe('chooseIdentity', () => {
  test('resolves without prompting when the human is only a patient', () => {
    expect(chooseIdentity([patient], 'user/Patient.rs')).toEqual({ action: 'resolved', identity: patient })
  })

  test('resolves without prompting when the scopes settle it', () => {
    expect(chooseIdentity([patient, practitioner], 'launch/patient'))
      .toEqual({ action: 'resolved', identity: patient })
  })

  test('asks when a launch scope is present but no EHR launch resolved', () => {
    expect(chooseIdentity([patient, practitioner], 'launch openid'))
      .toEqual({ action: 'choose', candidates: [patient, practitioner] })
  })

  test('never asks during an EHR launch', () => {
    expect(chooseIdentity([patient, practitioner], 'launch openid', { ehrLaunch: true }))
      .toEqual({ action: 'resolved', identity: practitioner })
  })

  test('asks when the request leaves it genuinely open', () => {
    const choice = chooseIdentity([patient, practitioner], 'user/Patient.rs openid fhirUser')
    expect(choice).toEqual({ action: 'choose', candidates: [patient, practitioner] })
  })

  test('answers none when the Person links to nothing usable', () => {
    expect(chooseIdentity([], 'launch/patient')).toEqual({ action: 'none' })
  })
})

describe('isOfferedIdentity', () => {
  test('accepts a reference the session offered', () => {
    expect(isOfferedIdentity('Practitioner/2', ['Patient/1', 'Practitioner/2'])).toBe(true)
  })

  test('refuses one it did not, which is the whole authorization check on the POST', () => {
    expect(isOfferedIdentity('Practitioner/999', ['Patient/1', 'Practitioner/2'])).toBe(false)
    expect(isOfferedIdentity('', ['Patient/1'])).toBe(false)
  })
})
