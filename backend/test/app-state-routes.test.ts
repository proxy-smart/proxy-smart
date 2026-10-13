// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { signTestToken } from './helpers/jwt-test-keys'
import { config } from '../src/config'
import { createAppStateRoutes } from '../src/routes/app-state'
import { createAppStateService, type AppStateServiceOptions } from '../src/lib/app-state/service'
import { MemoryAppStateBackend } from '../src/lib/app-state/store'
import type { AppStateRegistration } from '../src/lib/app-state/access'

const FHIR_BASE = `${config.baseUrl}/${config.name}/hapi/R4`
const PATIENT = `${FHIR_BASE}/Patient/a`
const PRACTITIONER = `${FHIR_BASE}/Practitioner/b`
const SYSTEM = 'https://app.example.org'
const CODE = `${SYSTEM}|prefs`
const ENDPOINT = 'http://localhost/app-state'

const REGISTRATIONS: Record<string, AppStateRegistration> = {
  'demo-app': { codes: new Set([CODE]), globalCodes: new Set() },
  'admin-app': { codes: new Set(), globalCodes: new Set([CODE]) },
}

function makeApp(overrides: Partial<AppStateServiceOptions> = {}) {
  const service = createAppStateService({
    backend: new MemoryAppStateBackend(),
    registrations: async (clientId) => REGISTRATIONS[clientId] ?? { codes: new Set(), globalCodes: new Set() },
    endpointUrl: () => ENDPOINT,
    fhirBaseUrlPrefix: () => `${config.baseUrl}/${config.name}/`,
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
    const res = await send(app, 'GET', `/Basic?code=${encodeURIComponent(CODE)}&subject=${encodeURIComponent(PATIENT)}`)
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
    const res = await send(app, 'GET', `/Basic?code=${encodeURIComponent(CODE)}&subject=${encodeURIComponent(PRACTITIONER)}`, { auth: token('user/Basic.s') })
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

  it('answers 412 without If-Match, or with a stale one', async () => {
    const app = makeApp()
    const { json: created } = await create(app)
    const update = basic({ id: created.id })
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: update })).status).toBe(412)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: update, ifMatch: 'W/"7"' })).status).toBe(412)
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
    expect((await send(app, 'DELETE', `/Basic/${created.id}`)).status).toBe(412)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`, { ifMatch: 'W/"9"' })).status).toBe(412)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`, { ifMatch: 'W/"1"' })).status).toBe(204)
    expect((await send(app, 'DELETE', `/Basic/${created.id}`, { ifMatch: 'W/"1"' })).status).toBe(412)
    expect((await send(app, 'PUT', `/Basic/${created.id}`, { body: basic({ id: created.id }), ifMatch: 'W/"1"' })).status).toBe(412)
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
