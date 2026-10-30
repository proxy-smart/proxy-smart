// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { accessControlParams } from '../src/lib/fhir-request-pipeline'

describe('accessControlParams', () => {
  it('names a parameter access control appended', () => {
    expect([...accessControlParams('?code=1234', '?code=1234&patient=Patient/p1')]).toEqual(['patient'])
  })

  it('names a parameter access control appended even when the client sent the same value', () => {
    expect([...accessControlParams('?patient=Patient/p1', '?patient=Patient/p1&patient=Patient/p1')]).toEqual(['patient'])
  })

  it('treats encoded and plain forms of one value as the same', () => {
    expect([...accessControlParams('?patient=Patient%2Fp1', '?patient=Patient%2Fp1&patient=Patient/p1')]).toEqual(['patient'])
  })

  it('names nothing when the query is unchanged', () => {
    expect(accessControlParams('?patient=Patient/p1&code=1', '?patient=Patient/p1&code=1').size).toBe(0)
  })

  it('names nothing for an empty query', () => {
    expect(accessControlParams('', '').size).toBe(0)
  })
})
