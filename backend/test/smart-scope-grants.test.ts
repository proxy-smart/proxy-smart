// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterEach } from 'bun:test'
import { resolveScopeGrant, resolveScopeOperation, isGrantablePermission } from '../src/lib/smart-scope-grants'
import { isSMARTScope, SMART_SCOPE_PATTERN } from '../src/lib/smart-client-enrichment'
import { enforceScopeAccess, type AccessControlContext } from '../src/lib/smart-access-control'

const grants = (scope: string, method: string, path: string, type = path.split('/')[0]) =>
  resolveScopeGrant([scope], type, method, path).kind

function ctx(scope: string, resourcePath: string, method = 'GET'): AccessControlContext {
  return {
    tokenPayload: { scope },
    resourcePath,
    method,
    serverUrl: 'https://fhir.example.com',
    serverId: 's',
    serverName: 's',
    authHeader: 'Bearer t',
    upstreamFetch: () => Promise.resolve(new Response('{}')),
  }
}

describe('cruds suffixes are an in-order subset of .cruds', () => {
  it('honours in-order suffixes', () => {
    expect(grants('patient/Observation.cu', 'POST', 'Observation')).toBe('full')
    expect(grants('patient/Observation.cu', 'PUT', 'Observation/1')).toBe('full')
    expect(grants('patient/Observation.rs', 'GET', 'Observation')).toBe('full')
    expect(grants('patient/Observation.ds', 'DELETE', 'Observation/1')).toBe('full')
  })

  it('grants nothing through an out-of-order suffix', () => {
    expect(grants('patient/Observation.dus', 'DELETE', 'Observation/1')).toBe('none')
    expect(grants('patient/Observation.dus', 'PUT', 'Observation/1')).toBe('none')
    expect(grants('patient/Observation.sr', 'GET', 'Observation')).toBe('none')
    expect(grants('patient/Observation.sr', 'GET', 'Observation/1')).toBe('none')
    expect(grants('patient/Observation.rc', 'POST', 'Observation')).toBe('none')
    expect(grants('patient/Observation.rr', 'GET', 'Observation/1')).toBe('none')
  })

  it('classifies permissions in one place', () => {
    for (const valid of ['c', 'rs', 'cruds', 'cud', 'read', 'write', '*']) expect(isGrantablePermission(valid)).toBe(true)
    for (const invalid of ['', 'sr', 'dus', 'rr', 'crudss', 'rx', 'Read']) expect(isGrantablePermission(invalid)).toBe(false)
  })

  it('keeps the admin scope pattern from creating out-of-order scopes', () => {
    expect(isSMARTScope('patient/Observation.rs')).toBe(true)
    expect(isSMARTScope('user/*.cruds')).toBe(true)
    expect(isSMARTScope('patient/Observation.sr')).toBe(false)
    expect(isSMARTScope('patient/Observation.dus')).toBe(false)
    expect(isSMARTScope('patient/Observation.sr?category=laboratory')).toBe(false)
    expect(SMART_SCOPE_PATTERN.test('patient/Observation.sr')).toBe(false)
    expect(SMART_SCOPE_PATTERN.test('patient/Observation.')).toBe(false)
    expect(SMART_SCOPE_PATTERN.test('system/*.cruds')).toBe(true)
  })
})

describe('history maps to the permission the spec names', () => {
  it('type and system history are searches, instance history and vread are reads', () => {
    expect(resolveScopeOperation('GET', 'Observation/_history')).toEqual({ effectiveMethod: 'GET', isSearch: true })
    expect(resolveScopeOperation('GET', '_history')).toEqual({ effectiveMethod: 'GET', isSearch: true })
    expect(resolveScopeOperation('GET', 'Observation/1/_history')).toEqual({ effectiveMethod: 'GET', isSearch: false })
    expect(resolveScopeOperation('GET', 'Observation/1/_history/2')).toEqual({ effectiveMethod: 'GET', isSearch: false })
  })

  it('needs s for type history and r for instance history', () => {
    expect(grants('patient/Observation.r', 'GET', 'Observation/_history')).toBe('none')
    expect(grants('patient/Observation.s', 'GET', 'Observation/_history')).toBe('full')
    expect(grants('patient/Observation.s', 'GET', 'Observation/1/_history')).toBe('none')
    expect(grants('patient/Observation.r', 'GET', 'Observation/1/_history/2')).toBe('full')
  })
})

describe('system-level history and search through enforceScopeAccess', () => {
  afterEach(() => { delete process.env.SCOPE_ENFORCEMENT_MODE })

  it.serial('judges [base]/_history like a search across all types', () => {
    process.env.SCOPE_ENFORCEMENT_MODE = 'enforce'
    expect(enforceScopeAccess(ctx('patient/Observation.rs', '_history')).allowed).toBe(false)
    expect(enforceScopeAccess(ctx('system/*.r', '_history')).allowed).toBe(false)
    expect(enforceScopeAccess(ctx('system/*.s', '_history')).allowed).toBe(true)
  })

  it.serial('accepts a POST search at the server base under a wildcard search scope', () => {
    process.env.SCOPE_ENFORCEMENT_MODE = 'enforce'
    expect(enforceScopeAccess(ctx('system/*.rs', '_search', 'POST')).allowed).toBe(true)
    expect(enforceScopeAccess(ctx('system/*.r', '_search', 'POST')).allowed).toBe(false)
    expect(enforceScopeAccess(ctx('system/*.rs', '', 'POST')).allowed).toBe(false)
  })
})
