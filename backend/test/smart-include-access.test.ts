// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterEach } from 'bun:test'
import { includeRefusals, enforceIncludeAccess, type IncludeRequest } from '../src/lib/smart-include-access'
import { authorizeFhirRequest, type FhirTarget } from '../src/lib/fhir-request-pipeline'

const search = (queryString: string, extra: Partial<IncludeRequest> = {}): IncludeRequest =>
  ({ method: 'GET', resourcePath: 'Observation', queryString, ...extra })

const refusals = (scope: string, queryString: string, extra: Partial<IncludeRequest> = {}) =>
  includeRefusals(scope.split(' '), search(queryString, extra))

describe('includeRefusals', () => {
  it('admits includes whose returned type the token can read', () => {
    expect(refusals('patient/Observation.rs patient/Patient.r', '?_include=Observation:subject:Patient')).toEqual([])
    expect(refusals('patient/Observation.rs patient/Patient.s', '?_include=Observation:patient')).toEqual([])
    expect(refusals('patient/Observation.rs patient/Provenance.rs', '?_revinclude=Provenance:target')).toEqual([])
    expect(refusals('patient/MedicationRequest.rs patient/Medication.rs', '?_include=MedicationRequest:medication', { resourcePath: 'MedicationRequest' })).toEqual([])
    expect(refusals('patient/Observation.rs', '?code=x')).toEqual([])
  })

  it('refuses includes reaching a type the token has no scope for', () => {
    expect(refusals('patient/Observation.rs', '?_include=Observation:performer:Practitioner')).toHaveLength(1)
    expect(refusals('patient/Observation.rs', '?_revinclude=Provenance:target')).toHaveLength(1)
    expect(refusals('patient/Observation.rs patient/Patient.r', '?_include:iterate=Patient:general-practitioner:Practitioner')).toHaveLength(1)
  })

  it('does not count a constrained scope or a write scope as readable', () => {
    expect(refusals('patient/Observation.rs patient/Practitioner.rs?active=true', '?_include=Observation:performer:Practitioner')).toHaveLength(1)
    expect(refusals('patient/Observation.rs patient/Practitioner.cud', '?_include=Observation:performer:Practitioner')).toHaveLength(1)
  })

  it('fails closed when the returned type is ambiguous, unless every type is readable', () => {
    expect(refusals('patient/Observation.rs patient/Patient.rs', '?_include=Observation:subject')).toHaveLength(1)
    expect(refusals('patient/Observation.rs patient/Patient.rs', '?_include=*')).toHaveLength(1)
    expect(refusals('patient/Observation.rs patient/Patient.rs', '?_revinclude=*')).toHaveLength(1)
    expect(refusals('patient/*.rs', '?_include=Observation:subject&_revinclude=*')).toEqual([])
    expect(refusals('patient/*.r', '?_include=*')).toEqual([])
  })

  it('reads the form body of a POST search too', () => {
    const form = { method: 'POST', resourcePath: 'Observation/_search', headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }) }
    expect(refusals('patient/Observation.rs', '', { ...form, body: '_include=Observation:performer:Practitioner' })).toHaveLength(1)
    expect(refusals('patient/Observation.rs', '', { ...form, body: 'code=x' })).toEqual([])
  })
})

describe('enforceIncludeAccess', () => {
  afterEach(() => { delete process.env.SCOPE_ENFORCEMENT_MODE })
  const token = { scope: 'patient/Observation.rs' }
  const req = search('?_include=Observation:performer:Practitioner')

  it.serial('refuses in enforce mode', () => {
    process.env.SCOPE_ENFORCEMENT_MODE = 'enforce'
    const result = enforceIncludeAccess(token, req, 'test-fhir')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
    expect(result.body?.error).toBe('insufficient_scope')
    expect(String(result.body?.message)).toContain('Practitioner')
  })

  it.serial('admits in audit-only and disabled modes', () => {
    process.env.SCOPE_ENFORCEMENT_MODE = 'audit-only'
    expect(enforceIncludeAccess(token, req, 'test-fhir').allowed).toBe(true)
    process.env.SCOPE_ENFORCEMENT_MODE = 'disabled'
    expect(enforceIncludeAccess(token, req, 'test-fhir').allowed).toBe(true)
  })
})

describe('authorizeFhirRequest', () => {
  afterEach(() => { delete process.env.SCOPE_ENFORCEMENT_MODE })

  it.serial('refuses an include past the token scopes before anything reaches upstream', async () => {
    process.env.SCOPE_ENFORCEMENT_MODE = 'enforce'
    const calls: string[] = []
    const target: FhirTarget = {
      serverInfo: { name: 'hapi', url: 'https://fhir.example.com', identifier: 'hapi', lastUpdated: 0, metadata: { fhirVersion: 'R4', serverVersion: 'x', serverName: 'x', supported: true } },
      serverName: 'hapi',
      fhirVersion: 'R4',
      upstreamFetch: async (url) => { calls.push(url); return new Response('{}') },
    }
    const caller = { tokenPayload: { scope: 'system/Observation.rs' }, authHeader: 'Bearer t' }
    const req = { method: 'GET', resourcePath: 'Observation', headers: new Headers() }
    const refused = await authorizeFhirRequest(target, caller, { ...req, queryString: '?_include=Observation:performer:Practitioner' })
    expect(refused.allowed).toBe(false)
    expect((await authorizeFhirRequest(target, caller, { ...req, queryString: '?code=x' })).allowed).toBe(true)
    expect(calls).toEqual([])
  })
})
