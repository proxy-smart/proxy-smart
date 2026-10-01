// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { enforceOperationPolicy } from '../src/lib/fhir-operation-policy'
import { parseFhirPath } from '../src/lib/fhir-capabilities'

const PATIENT_WILDCARD = { scope: 'openid patient/*.cruds', fhirUser: 'Patient/p1' }
const SYSTEM = { scope: 'system/*.rs' }

function check(path: string, method: string, token: Record<string, unknown> = PATIENT_WILDCARD, query = '') {
  return enforceOperationPolicy({ resourcePath: path, method, queryString: query, tokenPayload: token })
}

describe('parseFhirPath system-level operations', () => {
  it('recognises an operation on the server base', () => {
    const ctx = parseFhirPath('$expunge', 'POST')
    expect(ctx.isOperation).toBe(true)
    expect(ctx.operationName).toBe('expunge')
    expect(ctx.resourceType).toBeNull()
  })

  it('exposes the instance id', () => {
    expect(parseFhirPath('Condition/123/$erase', 'POST').resourceId).toBe('123')
    expect(parseFhirPath('Condition/123', 'GET').resourceId).toBe('123')
    expect(parseFhirPath('Condition', 'GET').resourceId).toBeNull()
  })
})

describe('enforceOperationPolicy', () => {
  it.each([
    ['$expunge', 'POST'],
    ['Condition/1/$expunge', 'POST'],
    ['Condition/$expunge', 'POST'],
    ['$reindex', 'POST'],
    ['$mark-all-resources-for-reindexing', 'POST'],
    ['Patient/$hapi.fhir.merge', 'POST'],
    ['$hapi.fhir.replace-references', 'POST'],
    ['$get-resource-counts', 'GET'],
  ])('refuses the administrative operation %s to any token', (path, method) => {
    for (const token of [PATIENT_WILDCARD, SYSTEM]) {
      const result = check(path, method, token)
      expect(result.allowed).toBe(false)
      expect(result.status).toBe(403)
    }
  })

  it('refuses expunging or cascading deletes through query parameters', () => {
    expect(check('Condition/1', 'DELETE', PATIENT_WILDCARD, '?_expunge=true').allowed).toBe(false)
    expect(check('Condition/1', 'DELETE', PATIENT_WILDCARD, '?_cascade=delete').allowed).toBe(false)
    expect(check('Condition/1', 'DELETE').allowed).toBe(true)
  })

  it('reserves bulk export for system scopes', () => {
    expect(check('$export', 'GET').allowed).toBe(false)
    expect(check('Patient/$export', 'GET').allowed).toBe(false)
    expect(check('Group/g1/$export', 'GET').allowed).toBe(false)
    expect(check('$export-poll-status', 'GET').allowed).toBe(false)
    expect(check('$export', 'GET', SYSTEM).allowed).toBe(true)
    expect(check('$export-poll-status', 'GET', SYSTEM).allowed).toBe(true)
  })

  it('leaves clinical operations and ordinary interactions alone', () => {
    expect(check('Patient/p1/$everything', 'GET').allowed).toBe(true)
    expect(check('Patient/$summary', 'GET').allowed).toBe(true)
    expect(check('ValueSet/$expand', 'GET').allowed).toBe(true)
    expect(check('Condition', 'POST').allowed).toBe(true)
    expect(check('Condition/1', 'PUT').allowed).toBe(true)
  })

  it('names the refused operation in an OperationOutcome', () => {
    const result = check('$expunge', 'POST')
    expect(result.body).toMatchObject({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden' }] })
    expect(JSON.stringify(result.body)).toContain('$expunge')
  })
})
