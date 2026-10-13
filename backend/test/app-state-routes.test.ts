// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { signTestToken } from './helpers/jwt-test-keys'
import { config } from '../src/config'
import { createAppStateRoutes } from '../src/routes/app-state'
import { createAppStateService, type AppStateServiceOptions } from '../src/lib/app-state/service'
import { MemoryAppStateBackend } from '../src/lib/app-state/store'
import { buildAppStateRegistration, NO_APP_STATE, type AppStateRegistration } from '../src/lib/app-state/registration'

const FHIR_BASE = `${config.baseUrl}/${config.name}/hapi/R4`
const PATIENT = `${FHIR_BASE}/Patient/a`
const PRACTITIONER = `${FHIR_BASE}/Practitioner/b`
const SYSTEM = 'https://app.example.org'
const CODE = `${SYSTEM}|prefs`
const ENDPOINT = 'http://localhost/app-state'
const OTHER_BASE = `${config.baseUrl}/${config.name}/other/R4`
const PLUS_CODE = `${SYSTEM}|a+b`
const SPACE_CODE = `${SYSTEM}|a b`

const REGISTRATIONS: Record<string, AppStateRegistration> = {
  'demo-app': buildAppStateRegistration({ codes: [CODE, PLUS_CODE, SPACE_CODE] }),
  'admin-app': buildAppStateRegistration({ globalCodes: [CODE] }),
  'companion-app': buildAppStateRegistration({ permissions: { patient: { query: [CODE] } } }),
}

const ONE_SERVER = [{ base: FHIR_BASE, upstream: 'http://hapi:8080/fhir' }]
const TWO_SERVERS = [...ONE_SERVER, { base: OTHER_BASE, upstream: 'http://other:8080/fhir' }]

function makeApp(overrides: Partial<AppStateServiceOptions> = {}) {
  const service = createAppStateService({
    backend: new MemoryAppStateBackend(),
    registrations: async (clientId) => REGISTRATIONS[clientId] ?? NO_APP_STATE,
    endpointUrl: () => ENDPOINT,
    fhirServers: async () => ONE_SERVER,
    limits: () => ({ maxResourceBytes: 256 * 1024, maxPerSubject: 3 }),
    ...overrides,
  })
  return createAppStateRoutes(service)
}

function token(scope: string, extra: Record<string, unknown> = {}, azp = 'demo-app'): string {
  return signTestToken({ azp, extra: { scope, patient: 'a', fhirUser: 'Practitioner/b', ...extra } })
}

const PATIENT_RW = token('launch/patient patient/Basic.cuds')

function basic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'Basic',
    subject: { reference: PATIENT },
    code: { coding: [{ system: SYSTEM, code: 'prefs' }] },
    extension: [{ url: `${SYSTEM}/prefs-v1`, valueString: '{"view":"labs"}' }],
    ...overrides,
  }
}

type App = ReturnType<typeof makeApp>

const search = (code: string, subject = PATIENT) => `/Basic?code=${encodeURIComponent(code)}&subject=${encodeURIComponent(subject)}`

function send(app: App, method: string, path: string, opts: { body?: unknown; raw?: string; auth?: string | null; ifMatch?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/fhir+json' }
  if (opts.auth !== null) headers.authorization = `Bearer ${opts.auth ?? PATIENT_RW}`
  if (opts.ifMatch) headers['if-match'] = opts.ifMatch
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  return app.handle(new Request(`${ENDPOINT}${path}`, { method, headers, body }))
}

async function create(app: App, resource = basic(), auth?: string) {
  const res = await send(app, 'POST', '/Basic', { body: resource, auth })
  return { res, json: await res.json() }
}

describe('POST /Basic', () => {
  it('persists the resource with a server id, versionId, ETag and Location', async () => {
    const app = makeApp()
    const { res, json } = await create(app)
    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toContain('application/fhir+json')
    expect(typeof json.id).toBe('string')
    expect(json.meta.versionId).toBe('1')
    expect(res.headers.get('etag')).toBe('W/"1"')
    expect(res.headers.get('location')).toBe(`${ENDPOINT}/Basic/${json.id}/_history/1`)
    expect(json.subject.reference).toBe(PATIENT)
    expect(json.code.coding[0].code).toBe('prefs')
    expect(json.extension[0].valueString).toBe('{"view":"labs"}')
  })

  it('rejects a body carrying id or meta.versionId', async () => {
    const app = makeApp()
    expect((await create(app, basic({ id: 'x' }))).res.status).toBe(400)
    expect((await create(app, basic({ meta: { versionId: '1' } }))).res.status).toBe(400)
  })

  it('rejects anything but exactly one coding', async () => {
    const app = makeApp()
    const two = basic({ code: { coding: [{ system: SYSTEM, code: 'prefs' }, { system: SYSTEM, code: 'other' }] } })
    expect((await create(app, two)).res.status).toBe(400)
  })

  it('rejects extensions that are not valueString, or nest extensions', async () => {
    const app = makeApp()
    expect((await create(app, basic({ extension: [{ url: 'u', valueInteger: 1 }] }))).res.status).toBe(400)
    expect((await create(app, basic({ extension: [{ url: 'u', valueString: 'x', extension: [] }] }))).res.status).toBe(400)
  })

  it('rejects a relative subject, an unsupported type, and a reference outside the proxied FHIR servers', async () => {
    const app = makeApp()
    expect((await create(app, basic({ subject: { reference: 'Patient/a' } }))).res.status).toBe(400)
    expect((await create(app, basic({ subject: { reference: `${FHIR_BASE}/Observation/1` } }))).res.status).toBe(400)
    expect((await create(app, basic({ subject: { reference: 'https://elsewhere.example.org/fhir/Patient/a' } }))).res.status).toBe(400)
  })

  it('rejects a body over the size limit with 413', async () => {
    const app = makeApp()
    const big = basic({ extension: [{ url: 'u', valueString: 'x'.repeat(256 * 1024) }] })
    expect((await create(app, big)).res.status).toBe(413)
  })

  it('rejects malformed JSON and a non-Basic resource', async () => {
    const app = makeApp()
    expect((await send(app, 'POST', '/Basic', { raw: '{nope' })).status).toBe(400)
    expect((await create(app, basic({ resourceType: 'Observation' }))).res.status).toBe(400)
  })

  it('answers 401 without a token and 401 with a bad one', async () => {
    const app = makeApp()
    const anonymous = await send(app, 'POST', '/Basic', { body: basic(), auth: null })
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer')
    expect((await send(app, 'POST', '/Basic', { body: basic(), auth: 'not-a-jwt' })).status).toBe(401)
  })

  it('refuses a code the app is not registered for', async () => {
    const app = makeApp()
    const other = basic({ code: { coding: [{ system: SYSTEM, code: 'unregistered' }] } })
    const { res, json } = await create(app, other)
    expect(res.status).toBe(403)
    expect(json.resourceType).toBe('OperationOutcome')
  })

  it('refuses state about a patient outside the token context', async () => {
    const app = makeApp()
    expect((await create(app, basic({ subject: { reference: `${FHIR_BASE}/Patient/z` } }))).res.status).toBe(403)
  })

  it('refuses a read-only scope', async () => {
    const app = makeApp()
    expect((await create(app, basic(), token('patient/Basic.s'))).res.status).toBe(403)
  })

  it('enforces the documented per-subject limit', async () => {
    const app = makeApp()
    for (let i = 0; i < 3; i++) expect((await create(app)).res.status).toBe(201)
    expect((await create(app)).res.status).toBe(422)
  })

  it('holds the per-subject limit under concurrent creates', async () => {
    const app = makeApp()
    const results = await Promise.all(Array.from({ length: 8 }, () => create(app)))
    expect(results.filter(({ res }) => res.status === 201)).toHaveLength(3)
    expect(results.filter(({ res }) => res.status === 422)).toHaveLength(5)
  })

  it('binds the in-context patient to the FHIR server the token belongs to', async () => {
    const app = makeApp({ fhirServers: async () => TWO_SERVERS })
    const onOther = basic({ subject: { reference: `${OTHER_BASE}/Patient/a` } })
    const forFirst = token('patient/Basic.cuds', { aud: FHIR_BASE })
    expect((await create(app, onOther, forFirst)).res.status).toBe(403)
    expect((await create(app, basic(), forFirst)).res.status).toBe(201)
    expect((await create(app, onOther, token('patient/Basic.cuds', { aud: OTHER_BASE }))).res.status).toBe(201)
  })

  it('refuses patient state when the token does not say which of several servers it is for', async () => {
    const app = makeApp({ fhirServers: async () => TWO_SERVERS })
    const { res, json } = await create(app)
    expect(res.status).toBe(403)
    expect(json.issue[0].diagnostics).toContain('FHIR server')
  })

  it('accepts subjects only on a FHIR server this proxy serves', async () => {
    const app = makeApp()
    expect((await create(app, basic({ subject: { reference: `${OTHER_BASE}/Patient/a` } }))).res.status).toBe(400)
  })

  it('keeps global writes for apps registered for them', async () => {
    const app = makeApp()
    const global = basic({ subject: undefined })
    expect((await create(app, global, token('user/Basic.cuds'))).res.status).toBe(403)
    expect((await create(app, global, token('user/Basic.cuds', {}, 'admin-app'))).res.status).toBe(201)
  })
})

describe('GET /Basic', () => {
  it('finds state by code and subject', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    const res = await send(app, 'GET', search(CODE))
    expect(res.status).toBe(200)
    const bundle = await res.json()
    expect(bundle.resourceType).toBe('Bundle')
    expect(bundle.type).toBe('searchset')
    expect(bundle.total).toBe(1)
    expect(bundle.entry[0].resource.id).toBe(created.id)
    expect(bundle.entry[0].fullUrl).toBe(`${ENDPOINT}/Basic/${created.id}`)
  })

  it('finds global state with subject:missing=true', async () => {
    const app = makeApp()
    await create(app, basic({ subject: undefined }), token('user/Basic.cuds', {}, 'admin-app'))
    await create(app)
    const res = await send(app, 'GET', `/Basic?code=${encodeURIComponent(CODE)}&subject:missing=true`, { auth: token('user/Basic.s') })
    const bundle = await res.json()
    expect(res.status).toBe(200)
    expect(bundle.total).toBe(1)
    expect(bundle.entry[0].resource.subject).toBeUndefined()
  })

  it('omits entry from an empty searchset', async () => {
    const app = makeApp()
    const bundle = await (await send(app, 'GET', search(CODE))).json()
    expect(bundle.total).toBe(0)
    expect('entry' in bundle).toBe(false)
  })

  it('matches a + in a code whether it is sent literally or percent-encoded', async () => {
    const app = makeApp()
    await create(app, basic({ code: { coding: [{ system: SYSTEM, code: 'a+b' }] } }))
    await create(app, basic({ code: { coding: [{ system: SYSTEM, code: 'a b' }] } }))
    const literal = await (await send(app, 'GET', `/Basic?code=${SYSTEM}|a+b&subject=${encodeURIComponent(PATIENT)}`)).json()
    expect(literal.total).toBe(1)
    expect(literal.entry[0].resource.code.coding[0].code).toBe('a+b')
    expect((await (await send(app, 'GET', search(PLUS_CODE))).json()).total).toBe(1)
    const space = await (await send(app, 'GET', search(SPACE_CODE))).json()
    expect(space.entry[0].resource.code.coding[0].code).toBe('a b')
  })

  it('accepts a percent-encoded colon in subject:missing', async () => {
    const app = makeApp()
    await create(app, basic({ subject: undefined }), token('user/Basic.cuds', {}, 'admin-app'))
    const res = await send(app, 'GET', `/Basic?code=${encodeURIComponent(CODE)}&subject%3Amissing=true`, { auth: token('user/Basic.s') })
    expect((await res.json()).total).toBe(1)
  })

  it('refuses several codes in one search, and a malformed escape', async () => {
    const app = makeApp()
    expect((await send(app, 'GET', search(`${CODE},${SYSTEM}|keys`))).status).toBe(400)
    expect((await send(app, 'GET', `/Basic?code=%E0%A4%A&subject=${encodeURIComponent(PATIENT)}`)).status).toBe(400)
  })

  it('lets a companion app registered to query a code read it but not modify it', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    const companion = token('launch/patient patient/*.cruds user/*.*', {}, 'companion-app')
    expect((await (await send(app, 'GET', search(CODE), { auth: companion })).json()).total).toBe(1)
    expect((await create(app, basic(), companion)).res.status).toBe(403)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: basic({ id: created.id }), ifMatch: 'W/"1"', auth: companion })).status).toBe(403)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`, { ifMatch: 'W/"1"', auth: companion })).status).toBe(403)
  })

  it('requires a code, and a subject or subject:missing=true', async () => {
    const app = makeApp()
    expect((await send(app, 'GET', `/Basic?subject=${encodeURIComponent(PATIENT)}`)).status).toBe(400)
    expect((await send(app, 'GET', `/Basic?code=${encodeURIComponent(CODE)}`)).status).toBe(400)
    expect((await send(app, 'GET', '/Basic?code=prefs&subject:missing=true')).status).toBe(400)
  })

  it('refuses a query about another patient', async () => {
    const app = makeApp()
    const other = `${FHIR_BASE}/Patient/z`
    expect((await send(app, 'GET', `/Basic?code=${encodeURIComponent(CODE)}&subject=${encodeURIComponent(other)}`)).status).toBe(403)
  })

  it('lets a user query their own state', async () => {
    const app = makeApp()
    await create(app, basic({ subject: { reference: PRACTITIONER } }), token('user/Basic.cuds'))
    const res = await send(app, 'GET', search(CODE, PRACTITIONER), { auth: token('user/Basic.s') })
    expect((await res.json()).total).toBe(1)
  })
})

describe('PUT /Basic/:id', () => {
  it('updates at the current version and returns the next ETag', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    const update = basic({ id: created.id, extension: [{ url: `${SYSTEM}/prefs-v1`, valueString: '{"view":"meds"}' }] })
    const res = await send(app, 'PUT', `/Basic/${created.id}`, { body: update, ifMatch: 'W/"1"' })
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('W/"2"')
    const json = await res.json()
    expect(json.meta.versionId).toBe('2')
    expect(json.extension[0].valueString).toBe('{"view":"meds"}')
  })

  it('answers 400 without If-Match and 412 with a stale one', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    const update = basic({ id: created.id })
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: update })).status).toBe(400)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: update, ifMatch: 'W/"7"' })).status).toBe(412)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: update, ifMatch: 'garbage' })).status).toBe(412)
  })

  it('answers 412 when subject or code changes', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    const newCode = basic({ id: created.id, code: { coding: [{ system: SYSTEM, code: 'other' }] } })
    const newSubject = basic({ id: created.id, subject: { reference: PRACTITIONER } })
    const dropped = basic({ id: created.id, subject: undefined })
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: newCode, ifMatch: 'W/"1"' })).status).toBe(412)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: newSubject, ifMatch: 'W/"1"' })).status).toBe(412)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: dropped, ifMatch: 'W/"1"' })).status).toBe(412)
  })

  it('requires Basic.id to match the URL', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: basic(), ifMatch: 'W/"1"' })).status).toBe(400)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: basic({ id: 'other' }), ifMatch: 'W/"1"' })).status).toBe(400)
  })

  it('refuses an update from a token that may not modify that state', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    const res = await send(app, 'PUT', `/Basic/${created.id}`, { body: basic({ id: created.id }), ifMatch: 'W/"1"', auth: token('patient/Basic.s') })
    expect(res.status).toBe(403)
  })
})

describe('DELETE /Basic/:id', () => {
  it('deletes at the current version, then treats the id as a failed precondition', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`)).status).toBe(400)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`, { ifMatch: 'W/"9"' })).status).toBe(412)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`, { ifMatch: 'W/"1"' })).status).toBe(204)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`, { ifMatch: 'W/"1"' })).status).toBe(412)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`)).status).toBe(412)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: basic({ id: created.id }), ifMatch: 'W/"1"' })).status).toBe(412)
  })

  it('answers any later PUT about a deleted id as a failed precondition, whatever its body', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`, { ifMatch: 'W/"1"' })).status).toBe(204)
    const put = (opts: { body?: unknown; raw?: string; ifMatch?: string }) => send(app, 'PUT', `/Basic/${created.id}`, opts)
    expect((await put({ raw: '{nope', ifMatch: 'W/"1"' })).status).toBe(412)
    expect((await put({ body: basic({ id: 'other' }), ifMatch: 'W/"1"' })).status).toBe(412)
    expect((await put({ body: basic({ id: created.id }) })).status).toBe(412)
  })

  it('refuses a delete without the d permission', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    const res = await send(app, 'DELETE', `/Basic/${created.id}`, { ifMatch: 'W/"1"', auth: token('patient/Basic.cus') })
    expect(res.status).toBe(403)
  })
})

describe('GET /metadata', () => {
  it('describes the endpoint against the SMART App State CapabilityStatement', async () => {
    const app = makeApp()
    const res = await app.handle(new Request(`${ENDPOINT}/metadata`))
    expect(res.status).toBe(200)
    const cs = await res.json()
    expect(cs.resourceType).toBe('CapabilityStatement')
    expect(cs.instantiates).toContain('http://hl7.org/fhir/smart-app-launch/CapabilityStatement/smart-app-state-server')
    const basicResource = cs.rest[0].resource.find((r: { type: string }) => r.type === 'Basic')
    expect(basicResource.interaction.map((i: { code: string }) => i.code).sort()).toEqual(['create', 'delete', 'search-type', 'update'])
  })
})
