// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { enforceScopeAccess, type AccessControlContext } from '../src/lib/smart-access-control'
import { parseResourceScope, resolveScopeGrant } from '../src/lib/smart-scope-grants'
import { constrainSearchQuery, enforceScopeConstraints, resourceSatisfiesConstraints } from '../src/lib/smart-scope-constraints'
import { resourceMatchesToken } from '../src/lib/fhir-token-match'
import { parseCapabilityStatement } from '../src/lib/fhir-capabilities'
import { isSMARTScope } from '../src/lib/smart-client-enrichment'
import { makeAccessContext } from './helpers/access-context'

const LAB_SYSTEM = 'http://terminology.hl7.org/CodeSystem/observation-category'
const LAB = `${LAB_SYSTEM}|laboratory`
const VITALS = `${LAB_SYSTEM}|vital-signs`
const LAB_SCOPE = `patient/Observation.rs?category=${LAB}`

type Upstream = (url: string) => Response

function bundleOf(count: number): Response {
  const entry = Array.from({ length: count }, (_, i) => ({ resource: { resourceType: 'Observation', id: `o${i}` } }))
  return new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry }), { status: 200 })
}

function scopedContext(scope: string, overrides: Partial<AccessControlContext> = {}, upstream: Upstream = () => bundleOf(0)): AccessControlContext {
  return makeAccessContext({
    tokenPayload: { scope, patient: 'p1' },
    resourcePath: 'Observation',
    upstreamFetch: mock((url: string) => Promise.resolve(upstream(url))),
    ...overrides,
  })
}

function labObservation(category = 'laboratory'): string {
  return JSON.stringify({
    resourceType: 'Observation',
    status: 'final',
    category: [{ coding: [{ system: LAB_SYSTEM, code: category }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] },
  })
}

function constraintsFor(scope: string, method = 'GET', path = 'Observation') {
  const grant = resolveScopeGrant(scope.split(' '), path.split('/')[0], method, path)
  if (grant.kind !== 'constrained') throw new Error(`expected a constrained grant, got ${grant.kind}`)
  return grant.constraints
}

describe('SMART 2.0 constrained scopes: parsing and grants', () => {
  it('parses the search-parameter suffix of a scope', () => {
    expect(parseResourceScope(LAB_SCOPE)).toEqual({
      context: 'patient', resourceType: 'Observation', permissions: 'rs', constraint: [['category', LAB]],
    })
  })

  it('makes a scope with an unparseable suffix grant nothing rather than everything', () => {
    expect(parseResourceScope('patient/Observation.rs?category')).toBeNull()
    expect(parseResourceScope('patient/Observation.rs?')).toBeNull()
    expect(resolveScopeGrant(['patient/Observation.rs?=x'], 'Observation', 'GET', 'Observation').kind).toBe('none')
  })

  it('lets an unconstrained scope for the same resource grant full access', () => {
    expect(resolveScopeGrant([LAB_SCOPE, 'patient/Observation.rs'], 'Observation', 'GET', 'Observation').kind).toBe('full')
    expect(resolveScopeGrant([LAB_SCOPE, 'patient/*.rs'], 'Observation', 'GET', 'Observation').kind).toBe('full')
  })

  it('collects every matching constrained scope as a union', () => {
    const grant = resolveScopeGrant([LAB_SCOPE, `patient/Observation.rs?category=${VITALS}`], 'Observation', 'GET', 'Observation')
    expect(grant.kind === 'constrained' && grant.constraints.length).toBe(2)
  })

  it('lists a constrained scope among SMART scopes, but not a malformed one', () => {
    expect(isSMARTScope(LAB_SCOPE)).toBe(true)
    expect(isSMARTScope('patient/Observation.xyz?category=x')).toBe(false)
    expect(isSMARTScope('patient/Observation.rs?category')).toBe(false)
  })

  it('still checks the permission characters of a constrained scope', () => {
    expect(resolveScopeGrant([LAB_SCOPE], 'Observation', 'POST', 'Observation').kind).toBe('none')
    expect(resolveScopeGrant([LAB_SCOPE], 'Condition', 'GET', 'Condition').kind).toBe('none')
  })
})

describe('enforceScopeAccess with constrained scopes', () => {
  afterEach(() => { delete process.env.SCOPE_ENFORCEMENT_MODE })

  it('admits the request and hands back the constraints instead of failing closed', () => {
    const result = enforceScopeAccess(scopedContext(LAB_SCOPE))
    expect(result.allowed).toBe(true)
    expect(result.scopeConstraints?.[0].params).toEqual([['category', LAB]])
  })

  it('returns no constraints when an unconstrained scope also covers the request', () => {
    expect(enforceScopeAccess(scopedContext(`${LAB_SCOPE} patient/Observation.rs`)).scopeConstraints).toBeUndefined()
  })

  it('judges a compartment search by the resource type it returns', () => {
    const ctx = scopedContext('patient/Patient.rs', { resourcePath: 'Patient/p1/Observation' })
    expect(enforceScopeAccess(ctx).allowed).toBe(false)
    expect(enforceScopeAccess(scopedContext('patient/Observation.s', { resourcePath: 'Patient/p1/Observation' })).allowed).toBe(true)
  })
})

describe('constrainSearchQuery', () => {
  const lab = constraintsFor(LAB_SCOPE)

  it('adds the constraint to a search that lacks it', () => {
    const result = constrainSearchQuery('?code=2345-7', lab)
    expect(result.ok && new URLSearchParams(result.queryString).getAll('category')).toEqual([LAB])
    expect(constrainSearchQuery('', lab)).toEqual({ ok: true, queryString: `?category=${encodeURIComponent(LAB)}` })
  })

  it('leaves a search alone that already asks for no more than the constraint', () => {
    expect(constrainSearchQuery(`?category=${encodeURIComponent(LAB)}`, lab)).toEqual({ ok: true, queryString: `?category=${encodeURIComponent(LAB)}` })
  })

  it('intersects a broader client value by adding the constraint as another AND clause', () => {
    const result = constrainSearchQuery(`?category=${encodeURIComponent(`${LAB},${VITALS}`)}`, lab)
    expect(result.ok && new URLSearchParams(result.queryString).getAll('category')).toEqual([`${LAB},${VITALS}`, LAB])
  })

  it('expresses a union of single-parameter constraints as FHIR OR', () => {
    const union = constraintsFor(`${LAB_SCOPE} patient/Observation.rs?category=${VITALS}`)
    const result = constrainSearchQuery('', union)
    expect(result.ok && new URLSearchParams(result.queryString).get('category')).toBe(`${LAB},${VITALS}`)
  })

  it('refuses a union it cannot express unless the client picks one constraint', () => {
    const mixed = constraintsFor(`${LAB_SCOPE} patient/Observation.rs?status=final&code=2345-7`)
    expect(constrainSearchQuery('?code=2345-7', mixed).ok).toBe(false)
    expect(constrainSearchQuery('?status=final&code=2345-7', mixed)).toEqual({ ok: true, queryString: '?status=final&code=2345-7' })
  })

  it('refuses _include and _revinclude, which reach resources outside the constraint', () => {
    expect(constrainSearchQuery('?_include=Observation:has-member', lab).ok).toBe(false)
    expect(constrainSearchQuery('?_revinclude:iterate=Observation:derived-from', lab).ok).toBe(false)
  })
})

describe('resource body evaluation', () => {
  it('matches token values in CodeableConcept, Coding and code elements', () => {
    const obs = JSON.parse(labObservation())
    expect(resourceMatchesToken(obs, 'category', LAB)).toBe(true)
    expect(resourceMatchesToken(obs, 'category', 'laboratory')).toBe(true)
    expect(resourceMatchesToken(obs, 'category', `${LAB_SYSTEM}|`)).toBe(true)
    expect(resourceMatchesToken(obs, 'category', `|laboratory`)).toBe(false)
    expect(resourceMatchesToken(obs, 'category', VITALS)).toBe(false)
    expect(resourceMatchesToken(obs, 'category', `${VITALS},${LAB}`)).toBe(true)
    expect(resourceMatchesToken(obs, 'status', 'final')).toBe(true)
    expect(resourceMatchesToken(obs, 'status', 'http://hl7.org/fhir/observation-status|final')).toBe(false)
  })

  it('cannot evaluate modifiers, chains or unknown parameters', () => {
    const obs = JSON.parse(labObservation())
    expect(resourceMatchesToken(obs, 'code:in', 'http://vs')).toBeUndefined()
    expect(resourceMatchesToken(obs, 'patient.birthdate', '2000')).toBeUndefined()
    expect(resourceSatisfiesConstraints(obs, constraintsFor('patient/Observation.cs?code:in=http://vs', 'POST'))).toBe(false)
  })
})

describe('enforceScopeConstraints', () => {
  beforeEach(() => { process.env.SCOPE_ENFORCEMENT_MODE = 'enforce' })
  afterEach(() => { delete process.env.SCOPE_ENFORCEMENT_MODE })

  const run = (ctx: AccessControlContext, req: { queryString?: string; body?: string } = {}) =>
    enforceScopeConstraints(ctx, { queryString: req.queryString ?? '', body: req.body }, constraintsFor(String(ctx.tokenPayload.scope), ctx.method, ctx.resourcePath))

  it('injects the constraint into a search', async () => {
    const result = await run(scopedContext(LAB_SCOPE), { queryString: '?code=2345-7' })
    expect(result.allowed).toBe(true)
    expect(new URLSearchParams(result.modifiedQueryString).get('category')).toBe(LAB)
  })

  it('verifies a read by id upstream with the constraint applied', async () => {
    const seen: string[] = []
    const ctx = scopedContext(LAB_SCOPE, { resourcePath: 'Observation/o1' }, (url) => { seen.push(url); return bundleOf(1) })
    expect((await run(ctx)).allowed).toBe(true)
    const url = new URL(seen[0])
    expect(url.pathname).toBe('/Observation')
    expect(url.searchParams.get('_id')).toBe('o1')
    expect(url.searchParams.get('category')).toBe(LAB)
  })

  it('refuses a read of a resource outside the constraint', async () => {
    const result = await run(scopedContext(LAB_SCOPE, { resourcePath: 'Observation/o2' }, () => bundleOf(0)))
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
  })

  it('fails closed when the upstream check fails', async () => {
    const result = await run(scopedContext(LAB_SCOPE, { resourcePath: 'Observation/o1' }, () => new Response('boom', { status: 500 })))
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(502)
  })

  it('refuses a read the upstream server cannot evaluate because it does not declare the parameter', async () => {
    const fetch = mock(() => Promise.resolve(bundleOf(1)))
    const ctx = scopedContext(LAB_SCOPE, { resourcePath: 'Observation/o1', upstreamFetch: fetch })
    const capabilities = parseCapabilityStatement({
      resourceType: 'CapabilityStatement',
      rest: [{ mode: 'server', resource: [{ type: 'Observation', searchParam: [{ name: 'code', type: 'token' }] }] }],
    }, 'https://fhir.example.com', 'test-server')
    const result = await enforceScopeConstraints(ctx, { queryString: '', capabilities }, constraintsFor(LAB_SCOPE, 'GET', 'Observation/o1'))
    expect(result.allowed).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  const WRITE_SCOPE = `patient/Observation.cud?category=${LAB}`

  it('admits a create whose body satisfies the constraint and refuses one that does not', async () => {
    const ctx = scopedContext(WRITE_SCOPE, { method: 'POST' })
    expect((await run(ctx, { body: labObservation() })).allowed).toBe(true)
    expect((await run(ctx, { body: labObservation('vital-signs') })).allowed).toBe(false)
    expect((await run(ctx, { body: '<Observation/>' })).allowed).toBe(false)
    expect((await run(ctx, { body: JSON.stringify({ resourceType: 'Condition' }) })).allowed).toBe(false)
  })

  it('checks both the new body and the stored resource on update', async () => {
    const stored = (matches: boolean, exists: boolean): Upstream => (url) =>
      new URL(url).searchParams.has('category') ? bundleOf(matches ? 1 : 0) : bundleOf(exists ? 1 : 0)
    const put = (upstream: Upstream) => scopedContext(WRITE_SCOPE, { method: 'PUT', resourcePath: 'Observation/o1' }, upstream)
    expect((await run(put(stored(true, true)), { body: labObservation() })).allowed).toBe(true)
    expect((await run(put(stored(false, true)), { body: labObservation() })).allowed).toBe(false)
    expect((await run(put(stored(false, false)), { body: labObservation() })).allowed).toBe(true)
    expect((await run(put(stored(true, true)), { body: labObservation('vital-signs') })).allowed).toBe(false)
  })

  it('verifies the stored resource before a delete', async () => {
    expect((await run(scopedContext(WRITE_SCOPE, { method: 'DELETE', resourcePath: 'Observation/o1' }, () => bundleOf(1)))).allowed).toBe(true)
    expect((await run(scopedContext(WRITE_SCOPE, { method: 'DELETE', resourcePath: 'Observation/o1' }, () => bundleOf(0)))).allowed).toBe(false)
  })

  it('refuses what it cannot evaluate: patch, conditional writes, history and operations', async () => {
    expect((await run(scopedContext(WRITE_SCOPE, { method: 'PATCH', resourcePath: 'Observation/o1' }))).allowed).toBe(false)
    expect((await run(scopedContext(WRITE_SCOPE, { method: 'DELETE', resourcePath: 'Observation' }), { queryString: '?code=x' })).allowed).toBe(false)
    expect((await run(scopedContext(LAB_SCOPE, { resourcePath: 'Observation/o1/_history/2' }))).allowed).toBe(false)
    expect((await run(scopedContext(LAB_SCOPE, { resourcePath: 'Observation/$lastn' }))).allowed).toBe(false)
  })

  it('only logs in audit-only mode', async () => {
    process.env.SCOPE_ENFORCEMENT_MODE = 'audit-only'
    const search = await run(scopedContext(LAB_SCOPE), { queryString: '?code=x' })
    expect(search).toEqual({ allowed: true, modifiedQueryString: '?code=x' })
    expect((await run(scopedContext(LAB_SCOPE, { resourcePath: 'Observation/o2' }, () => bundleOf(0)))).allowed).toBe(true)
  })
})
