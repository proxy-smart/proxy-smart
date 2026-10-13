// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { fhirContextIssues } from './fhir-context'

describe('fhirContext items (SMART scopes-and-launch-context)', () => {
  test('accepts reference, canonical and identifier items', () => {
    expect(fhirContextIssues([
      { reference: 'DiagnosticReport/1' },
      { canonical: 'http://example.org/Questionnaire/q|1.0', type: 'Questionnaire' },
      { identifier: { system: 'urn:x', value: '7' }, type: 'ImagingStudy', role: 'https://example.org/roles/primary' },
      { reference: 'ServiceRequest/2', role: 'launch' },
    ])).toEqual([])
  })

  test('an item needs reference, canonical or identifier', () => {
    expect(fhirContextIssues([{ type: 'Observation' }])).toEqual([
      'fhirContext[0] must include reference, canonical or identifier',
    ])
  })

  test('role may be omitted but never empty', () => {
    expect(fhirContextIssues([{ reference: 'Observation/1', role: '' }])[0]).toContain('role')
  })

  test('a role other than the spec-defined "launch" must be an absolute URI', () => {
    expect(fhirContextIssues([{ reference: 'Observation/1', role: 'primary' }])[0]).toContain('absolute URI')
  })

  test('Patient and Encounter belong in the top-level parameters unless they carry another role', () => {
    expect(fhirContextIssues([{ reference: 'Patient/1' }])).toHaveLength(1)
    expect(fhirContextIssues([{ reference: 'https://fhir.example.com/R4/Encounter/2', role: 'launch' }])).toHaveLength(1)
    expect(fhirContextIssues([{ identifier: { value: '9' }, type: 'Patient' }])).toHaveLength(1)
    expect(fhirContextIssues([{ reference: 'Patient/1', role: 'https://example.org/roles/donor' }])).toEqual([])
  })

  test('every broken item is reported, by position', () => {
    const issues = fhirContextIssues([{ reference: 'Observation/1' }, { role: 'x' }, { reference: 'Patient/1' }])
    expect(issues.some((i) => i.startsWith('fhirContext[1]'))).toBe(true)
    expect(issues.some((i) => i.startsWith('fhirContext[2]'))).toBe(true)
    expect(issues.some((i) => i.startsWith('fhirContext[0]'))).toBe(false)
  })
})
