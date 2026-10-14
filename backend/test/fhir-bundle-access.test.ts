// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { handleFhirBundle, narrowingAlreadyPresent, resolveEntryUrl, type BundleContext } from '../src/lib/fhir-bundle-access'
import {
  authorizeFhirRequest, executeFhirRequest,
  type FhirAuthorization, type FhirCaller, type FhirProxyResult, type FhirRequestInput, type FhirTarget,
} from '../src/lib/fhir-request-pipeline'
import { enforceScopeAccess, type AccessControlContext } from '../src/lib/smart-access-control'

const BASE = 'https://proxy.example.com/proxy-smart-backend/hapi/R4'

function bundle(type: string, entries: unknown[]): string {
  return JSON.stringify({ resourceType: 'Bundle', type, entry: entries })
}

function entry(method: string, url: string, resource?: Record<string, unknown>) {
  return { ...(resource && { resource }), request: { method, url } }
}

function fakeContext(overrides: Partial<BundleContext> = {}): BundleContext & { executed: FhirRequestInput[]; forwarded: string[] } {
  const executed: FhirRequestInput[] = []
  const forwarded: string[] = []
  return {
    proxyBase: BASE,
    maxEntries: 10,
    headers: new Headers({ authorization: 'Bearer t', accept: 'application/fhir+json' }),
    authorize: async (req): Promise<FhirAuthorization> => ({ allowed: true, queryString: req.queryString, tenantOrgId: null }),
    execute: async (req): Promise<FhirProxyResult> => {
      executed.push(req)
      return { status: 200, headers: { etag: 'W/"1"' }, body: { resourceType: req.resourcePath.split('/')[0], id: '1' } }
    },
    forwardTransaction: async (body) => {
      forwarded.push(body)
      return { status: 200, headers: {}, body: { resourceType: 'Bundle', type: 'transaction-response' } }
    },
    executed,
    forwarded,
    ...overrides,
  }
}

function responseBundle(res: FhirProxyResult): Array<{ response: Record<string, unknown>; resource?: Record<string, unknown> }> {
  const body = res.body
  if (typeof body !== 'object' || body === null || !('entry' in body) || !Array.isArray(body.entry)) throw new Error('not a bundle')
  return body.entry
}

describe('Bundle validation', () => {
  it('accepts only JSON Bundles of type batch or transaction', async () => {
    const ctx = fakeContext()
    expect((await handleFhirBundle('not json', ctx)).status).toBe(400)
    expect((await handleFhirBundle(JSON.stringify({ resourceType: 'Patient' }), ctx)).status).toBe(400)
    expect((await handleFhirBundle(bundle('collection', []), ctx)).status).toBe(400)
    expect((await handleFhirBundle(bundle('batch', []), ctx)).status).toBe(200)
  })

  it('bounds the number of entries', async () => {
    const entries = Array.from({ length: 11 }, () => entry('GET', 'Patient/1'))
    const res = await handleFhirBundle(bundle('batch', entries), fakeContext())
    expect(res.status).toBe(413)
    expect(JSON.stringify(res.body)).toContain('at most 10')
  })

  it('resolves relative and proxy-absolute entry URLs, nothing else', () => {
    expect(resolveEntryUrl('Patient/1', BASE)).toEqual({ resourcePath: 'Patient/1', queryString: '' })
    expect(resolveEntryUrl('/Observation?code=x', BASE)).toEqual({ resourcePath: 'Observation', queryString: '?code=x' })
    expect(resolveEntryUrl(`${BASE}/Patient/1`, BASE)).toEqual({ resourcePath: 'Patient/1', queryString: '' })
    expect(resolveEntryUrl('https://elsewhere.example.com/fhir/Patient/1', BASE)).toBeNull()
    expect(resolveEntryUrl('Patient/../admin', BASE)).toBeNull()
    expect(resolveEntryUrl('', BASE)).toBeNull()
  })
})

describe('batch', () => {
  it('runs every entry through the per-request pipeline and answers with a batch-response', async () => {
    const ctx = fakeContext()
    const res = await handleFhirBundle(bundle('batch', [
      entry('GET', 'Patient/1'),
      entry('POST', 'Observation', { resourceType: 'Observation', status: 'final' }),
    ]), ctx)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ resourceType: 'Bundle', type: 'batch-response' })
    expect(ctx.executed.map((r) => `${r.method} ${r.resourcePath}`)).toEqual(['GET Patient/1', 'POST Observation'])
    expect(ctx.executed[1].body).toBe(JSON.stringify({ resourceType: 'Observation', status: 'final' }))
    expect(ctx.executed[1].headers.get('content-type')).toBe('application/fhir+json')
    const [first] = responseBundle(res)
    expect(first.response).toEqual({ status: '200 OK', etag: 'W/"1"' })
    expect(first.resource).toEqual({ resourceType: 'Patient', id: '1' })
  })

  it('reports a denied entry with an OperationOutcome without failing the others', async () => {
    const ctx = fakeContext({
      execute: async (req): Promise<FhirProxyResult> => req.resourcePath.startsWith('Condition')
        ? { status: 403, headers: {}, body: { error: 'insufficient_scope', message: 'no Condition scope' } }
        : { status: 201, headers: { location: `${BASE}/Observation/9/_history/1` }, body: { resourceType: 'Observation', id: '9' } },
    })
    const entries = responseBundle(await handleFhirBundle(bundle('batch', [
      entry('GET', 'Condition?patient=1'),
      entry('POST', 'Observation', { resourceType: 'Observation' }),
      { request: { url: 'Patient/1' } },
    ]), ctx))
    expect(entries[0].response.status).toBe('403 Forbidden')
    expect(entries[0].response.outcome).toMatchObject({ resourceType: 'OperationOutcome', issue: [{ code: 'forbidden', diagnostics: 'no Condition scope' }] })
    expect(entries[1].response).toMatchObject({ status: '201 Created', location: `${BASE}/Observation/9/_history/1` })
    expect(entries[2].response.status).toBe('400 Bad Request')
  })

  it('maps request conditionals onto headers', async () => {
    const ctx = fakeContext()
    await handleFhirBundle(bundle('batch', [{ resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient', ifNoneExist: 'identifier=x|1' } }]), ctx)
    expect(ctx.executed[0].headers.get('if-none-exist')).toBe('identifier=x|1')
  })
})

describe('transaction', () => {
  it('forwards an admitted transaction upstream unchanged', async () => {
    const ctx = fakeContext()
    const text = bundle('transaction', [entry('POST', 'Observation', { resourceType: 'Observation' }), entry('GET', 'Patient/1')])
    const res = await handleFhirBundle(text, ctx)
    expect(res.status).toBe(200)
    expect(ctx.forwarded).toEqual([text])
    expect(ctx.executed).toEqual([])
  })

  it('refuses the whole transaction when one entry is denied, naming the entry', async () => {
    const ctx = fakeContext({
      authorize: async (req) => req.resourcePath === 'Condition'
        ? { allowed: false, status: 403, body: { error: 'insufficient_scope', message: 'no Condition scope' } }
        : { allowed: true, queryString: req.queryString, tenantOrgId: null },
    })
    const res = await handleFhirBundle(bundle('transaction', [
      entry('POST', 'Observation', { resourceType: 'Observation' }),
      entry('POST', 'Condition', { resourceType: 'Condition' }),
    ]), ctx)
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({
      resourceType: 'OperationOutcome',
      issue: [{ code: 'forbidden', expression: ['Bundle.entry[1]'], diagnostics: 'Bundle.entry[1] (POST Condition): no Condition scope' }],
    })
    expect(ctx.forwarded).toEqual([])
  })

  it('refuses a search the compartment filter would have to rewrite, accepts one already in the compartment', async () => {
    const ctx = fakeContext({
      authorize: async (req) => ({ allowed: true, queryString: `${req.queryString}&patient=Patient/p1`, tenantOrgId: null }),
    })
    expect((await handleFhirBundle(bundle('transaction', [entry('GET', 'Observation?code=x')]), ctx)).status).toBe(403)
    expect((await handleFhirBundle(bundle('transaction', [entry('GET', 'Observation?code=x&patient=p1')]), ctx)).status).toBe(200)
  })

  it('refuses an invalid entry and $erase, which only the proxy answers', async () => {
    expect((await handleFhirBundle(bundle('transaction', [{ request: { method: 'GET' } }]), fakeContext())).status).toBe(400)
    expect((await handleFhirBundle(bundle('transaction', [entry('POST', 'Observation/1/$erase')]), fakeContext())).status).toBe(400)
  })

  it('treats narrowing as present only when every added parameter is already asked for', () => {
    expect(narrowingAlreadyPresent('?code=x', '?code=x')).toBe(true)
    expect(narrowingAlreadyPresent('?patient=Patient/p1', '?patient=Patient/p1&patient=Patient/p1')).toBe(true)
    expect(narrowingAlreadyPresent('?patient=p1', '?patient=p1&patient=Patient/p1')).toBe(true)
    expect(narrowingAlreadyPresent('?code=x', '?code=x&patient=Patient/p1')).toBe(false)
    expect(narrowingAlreadyPresent('', '?_tag=org%7C1')).toBe(false)
  })
})

const upstreamCalls: string[] = []
const target: FhirTarget = {
  serverInfo: {
    name: 'hapi', url: 'http://127.0.0.1:1/fhir', identifier: 'bundle-test', lastUpdated: 0,
    metadata: { fhirVersion: '4.0.1', supported: true },
  },
  serverName: 'hapi',
  fhirVersion: 'R4',
  upstreamFetch: mock(async (url: string) => {
    upstreamCalls.push(url)
    return new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: [] }), {
      status: 200, headers: { 'content-type': 'application/fhir+json' },
    })
  }),
}

function pipelineContext(caller: FhirCaller): BundleContext {
  return {
    proxyBase: BASE,
    maxEntries: 10,
    headers: new Headers(),
    authorize: (req) => authorizeFhirRequest(target, caller, req),
    execute: (req) => executeFhirRequest(target, caller, req),
    forwardTransaction: async () => ({ status: 200, headers: {}, body: { resourceType: 'Bundle', type: 'transaction-response' } }),
  }
}

describe('Bundles through the real access-control pipeline', () => {
  beforeEach(() => {
    process.env.SCOPE_ENFORCEMENT_MODE = 'enforce'
    process.env.ROLE_BASED_FILTERING_MODE = 'enforce'
    // Scope and compartment are under test; consent has its own suites.
    process.env.CONSENT_ENABLED = 'false'
  })
  afterEach(() => {
    delete process.env.SCOPE_ENFORCEMENT_MODE
    delete process.env.ROLE_BASED_FILTERING_MODE
    delete process.env.CONSENT_ENABLED
  })

  const caller = { tokenPayload: { sub: 'u1', scope: 'openid patient/Observation.rs', patient: 'p1' }, authHeader: 'Bearer t' }
  const ctx = (): BundleContext => pipelineContext(caller)

  it.serial('no longer refuses a Bundle at the base outright, but still refuses a raw base write', () => {
    const acCtx: AccessControlContext = {
      tokenPayload: caller.tokenPayload, resourcePath: '', method: 'POST', serverUrl: '', serverId: '', serverName: '', authHeader: '',
      upstreamFetch: target.upstreamFetch,
    }
    expect(enforceScopeAccess(acCtx).allowed).toBe(false)
  })

  it.serial('narrows each batch search to the patient and refuses entries outside the grant', async () => {
    upstreamCalls.length = 0
    const entries = responseBundle(await handleFhirBundle(bundle('batch', [
      entry('GET', 'Observation?code=x'),
      entry('GET', 'Condition'),
      entry('POST', 'Observation', { resourceType: 'Observation' }),
    ]), ctx()))
    expect(entries.map((e) => e.response.status)).toEqual(['200 OK', '403 Forbidden', '403 Forbidden'])
    expect(upstreamCalls).toHaveLength(1)
    expect(new URL(upstreamCalls[0]).searchParams.get('patient')).toBe('Patient/p1')
  })

  it.serial('refuses a transaction carrying a write the token cannot make', async () => {
    const res = await handleFhirBundle(bundle('transaction', [
      entry('GET', 'Observation?patient=Patient/p1'),
      entry('DELETE', 'Patient/p2'),
    ]), ctx())
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('Bundle.entry[1] (DELETE Patient/p2)')
  })

  describe('with patient-scoped write access', () => {
    const writer = { tokenPayload: { sub: 'u1', scope: 'openid patient/Observation.cruds', patient: 'p1' }, authHeader: 'Bearer t' }
    const obs = (subject: string) => ({ resourceType: 'Observation', status: 'final', subject: { reference: subject } })

    it.serial('confines each batch write to the in-context patient', async () => {
      upstreamCalls.length = 0
      const entries = responseBundle(await handleFhirBundle(bundle('batch', [
        entry('POST', 'Observation', obs('Patient/p1')),
        entry('POST', 'Observation', obs('Patient/p2')),
      ]), pipelineContext(writer)))
      expect(entries[0].response.status).toBe('200 OK')
      expect(entries[1].response.status).toBe('403 Forbidden')
      expect(upstreamCalls.filter((u) => new URL(u).pathname.endsWith('/Observation'))).toHaveLength(1)
    })

    it.serial('refuses a transaction that writes into another patient compartment', async () => {
      const res = await handleFhirBundle(bundle('transaction', [
        entry('POST', 'Observation', obs('Patient/p1')),
        entry('POST', 'Observation', obs('Patient/p2')),
      ]), pipelineContext(writer))
      expect(res.status).toBe(403)
      expect(JSON.stringify(res.body)).toContain('Bundle.entry[1] (POST Observation)')
    })

    it.serial('refuses a conditional create inside a transaction', async () => {
      const res = await handleFhirBundle(bundle('transaction', [
        { resource: obs('Patient/p1'), request: { method: 'POST', url: 'Observation', ifNoneExist: 'identifier=x|1' } },
      ]), pipelineContext(writer))
      expect(res.status).toBe(403)
    })
  })
})
