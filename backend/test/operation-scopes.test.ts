// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { operationReadRefusal } from '../src/lib/operation-scopes'

const refusal = (scopes: string, path: string, method = 'GET') => operationReadRefusal(scopes.split(' '), path, method)

describe('operationReadRefusal', () => {
  it('needs a wildcard read for operations that return every type', () => {
    expect(refusal('patient/Patient.r', 'Patient/p1/$everything')).not.toBeNull()
    expect(refusal('patient/Patient.rs patient/Observation.rs', 'Patient/p1/$summary')).not.toBeNull()
    expect(refusal('user/Composition.rs', 'Composition/c1/$document')).not.toBeNull()
    expect(refusal('user/Patient.rs', 'Patient/$everything')).not.toBeNull()
    expect(refusal('patient/Patient.rs', 'Patient/p1/$graphql', 'POST')).not.toBeNull()
  })

  it('accepts a wildcard read in any context for patient-level operations', () => {
    expect(refusal('patient/*.rs', 'Patient/p1/$everything')).toBeNull()
    expect(refusal('patient/*.read', 'Patient/p1/$summary')).toBeNull()
    expect(refusal('user/*.rs', 'Patient/$everything')).toBeNull()
    expect(refusal('user/*.rs', 'Composition/c1/$document')).toBeNull()
  })

  it('treats a POST operation as a read, so a create grant does not reach it', () => {
    expect(refusal('patient/Patient.c', 'Patient/p1/$everything', 'POST')).not.toBeNull()
    expect(refusal('patient/*.c', 'Patient/p1/$everything', 'POST')).not.toBeNull()
    expect(refusal('patient/*.rs', 'Patient/p1/$everything', 'POST')).toBeNull()
  })

  it('needs a system wildcard read for bulk export', () => {
    expect(refusal('system/Patient.rs', 'Patient/$export')).not.toBeNull()
    expect(refusal('system/Patient.rs user/*.rs', 'Group/g1/$export')).not.toBeNull()
    expect(refusal('system/*.rs', '$export')).toBeNull()
    expect(refusal('system/*.read', 'Group/g1/$export')).toBeNull()
  })

  it('refuses a constrained wildcard, which an operation cannot be narrowed by', () => {
    expect(refusal('patient/*.rs?category=laboratory', 'Patient/p1/$everything')).not.toBeNull()
  })

  it('leaves other requests to the ordinary scope check', () => {
    expect(refusal('patient/Observation.rs', 'Observation/$lastn')).toBeNull()
    expect(refusal('patient/Patient.r', 'Patient/p1')).toBeNull()
    expect(refusal('patient/Patient.rs', 'Patient')).toBeNull()
  })
})
