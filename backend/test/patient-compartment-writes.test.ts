// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { enforceRoleBasedFiltering, type AccessControlContext } from '../src/lib/smart-access-control'
import { patientCompartmentVerdict } from '../src/lib/patient-compartment/definition'
import { patchRefusal } from '../src/lib/patient-compartment/patch-guard'

const SERVER = 'https://fhir.example.com/fhir'
const CONFINED = { scope: 'openid patient/*.cruds', fhirUser: 'Practitioner/dr-smith', patient: 'p1' }

function upstreamReturning(resources: Array<Record<string, unknown>>) {
  return mock(async (_url: string) => new Response(JSON.stringify({
    resourceType: 'Bundle', type: 'searchset', entry: resources.map((resource) => ({ resource })),
  }), { status: 200, headers: { 'content-type': 'application/fhir+json' } }))
}

function makeCtx(overrides: Partial<AccessControlContext> = {}): AccessControlContext {
  return {
    tokenPayload: CONFINED,
    resourcePath: 'Observation',
    method: 'POST',
    serverUrl: SERVER,
    serverId: 'test-server',
    serverName: 'test-fhir',
    authHeader: 'Bearer t',
    upstreamFetch: upstreamReturning([]),
    ...overrides,
  }
}

function observation(subject: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ resourceType: 'Observation', status: 'final', subject: { reference: subject }, ...extra })
}

async function write(method: string, resourcePath: string, body?: string, options: {
  ctx?: Partial<AccessControlContext>
  query?: string
  headers?: Record<string, string>
} = {}) {
  return enforceRoleBasedFiltering(
    makeCtx({ method, resourcePath, ...options.ctx }),
    options.query ?? '',
    { body, headers: new Headers(options.headers ?? {}) },
  )
}

const stored = (subject: string) => ({ resourceType: 'Observation', id: 'o1', subject: { reference: subject } })

function resetEnv() {
  delete process.env.ROLE_BASED_FILTERING_MODE
}

describe('Patient compartment writes', () => {
  beforeEach(() => { process.env.ROLE_BASED_FILTERING_MODE = 'enforce' })
  afterEach(resetEnv)

  describe('create', () => {
    it.serial('admits a resource that belongs to the in-context patient', async () => {
      expect((await write('POST', 'Observation', observation('Patient/p1'))).allowed).toBe(true)
      expect((await write('POST', 'Observation', observation(`${SERVER}/Patient/p1`))).allowed).toBe(true)
    })

    it.serial('refuses a resource that belongs to another patient', async () => {
      const result = await write('POST', 'Observation', observation('Patient/p2'))
      expect(result.allowed).toBe(false)
      expect(result.status).toBe(403)
      expect(result.body?.error).toBe('access_denied')
    })

    it.serial('refuses a resource that also reaches another patient through a second compartment element', async () => {
      const body = observation('Patient/p1', { performer: [{ reference: 'Patient/p2' }] })
      expect((await write('POST', 'Observation', body)).allowed).toBe(false)
    })

    it.serial('reads the compartment elements of each type, not just subject', async () => {
      const allergy = JSON.stringify({ resourceType: 'AllergyIntolerance', patient: { reference: 'Patient/p1' } })
      const encounter = JSON.stringify({ resourceType: 'Encounter', status: 'planned', subject: { reference: 'Patient/p2' } })
      const appointment = JSON.stringify({ resourceType: 'Appointment', participant: [{ actor: { reference: 'Patient/p1' } }] })
      expect((await write('POST', 'AllergyIntolerance', allergy)).allowed).toBe(true)
      expect((await write('POST', 'Encounter', encounter)).allowed).toBe(false)
      expect((await write('POST', 'Appointment', appointment)).allowed).toBe(true)
    })

    it.serial('fails closed on references it cannot resolve to this server', async () => {
      for (const subject of ['https://elsewhere.example.com/fhir/Patient/p1', 'urn:uuid:4f1c', '#contained', 'Patient?identifier=x/Patient/p1']) {
        expect((await write('POST', 'Observation', observation(subject))).allowed).toBe(false)
      }
    })

    it.serial('refuses a resource that does not reference the patient at all', async () => {
      expect((await write('POST', 'Observation', observation('Group/g1'))).allowed).toBe(false)
      expect((await write('POST', 'Observation', JSON.stringify({ resourceType: 'Observation', status: 'final' }))).allowed).toBe(false)
    })

    it.serial('refuses types outside the Patient compartment and new Patient records', async () => {
      const practitioner = JSON.stringify({ resourceType: 'Practitioner', name: [{ family: 'X' }] })
      expect((await write('POST', 'Practitioner', practitioner, { ctx: { resourcePath: 'Practitioner' } })).allowed).toBe(false)
      expect((await write('POST', 'Patient', JSON.stringify({ resourceType: 'Patient' }))).allowed).toBe(false)
    })

    it.serial('refuses a body it cannot evaluate', async () => {
      expect((await write('POST', 'Observation', '<Observation xmlns="http://hl7.org/fhir"/>')).allowed).toBe(false)
      expect((await write('POST', 'Observation', undefined)).allowed).toBe(false)
      expect((await write('POST', 'Observation', JSON.stringify({ resourceType: 'Condition', subject: { reference: 'Patient/p1' } }))).allowed).toBe(false)
    })

    it.serial('refuses a conditional create', async () => {
      const result = await write('POST', 'Observation', observation('Patient/p1'), { headers: { 'if-none-exist': 'identifier=x|1' } })
      expect(result.allowed).toBe(false)
    })
  })

  describe('update', () => {
    it.serial('admits an update of a stored resource in the compartment that stays there', async () => {
      const upstreamFetch = upstreamReturning([stored('Patient/p1')])
      const result = await write('PUT', 'Observation/o1', observation('Patient/p1', { id: 'o1' }), { ctx: { upstreamFetch } })
      expect(result.allowed).toBe(true)
      const url = new URL(String(upstreamFetch.mock.calls[0][0]))
      expect(url.searchParams.get('_id')).toBe('o1')
    })

    it.serial('refuses taking over another patient\'s resource', async () => {
      const result = await write('PUT', 'Observation/o1', observation('Patient/p1', { id: 'o1' }), {
        ctx: { upstreamFetch: upstreamReturning([stored('Patient/p2')]) },
      })
      expect(result.allowed).toBe(false)
      expect(result.status).toBe(403)
    })

    it.serial('refuses moving a resource to another patient', async () => {
      const result = await write('PUT', 'Observation/o1', observation('Patient/p2', { id: 'o1' }), {
        ctx: { upstreamFetch: upstreamReturning([stored('Patient/p1')]) },
      })
      expect(result.allowed).toBe(false)
    })

    it.serial('admits an update-as-create when nothing is stored under that id', async () => {
      expect((await write('PUT', 'Observation/o1', observation('Patient/p1', { id: 'o1' }))).allowed).toBe(true)
    })

    it.serial('answers 502 when the stored resource cannot be checked', async () => {
      const upstreamFetch = mock(async () => new Response('down', { status: 500 }))
      const result = await write('PUT', 'Observation/o1', observation('Patient/p1', { id: 'o1' }), { ctx: { upstreamFetch } })
      expect(result.allowed).toBe(false)
      expect(result.status).toBe(502)
    })

    it.serial('refuses a conditional update', async () => {
      expect((await write('PUT', 'Observation', observation('Patient/p1'), { query: '?identifier=x|1' })).allowed).toBe(false)
    })

    it.serial('confines the Patient resource to the in-context patient by id', async () => {
      const own = JSON.stringify({ resourceType: 'Patient', id: 'p1', active: true })
      const other = JSON.stringify({ resourceType: 'Patient', id: 'p2', active: true })
      const relinked = JSON.stringify({ resourceType: 'Patient', id: 'p1', link: [{ other: { reference: 'Patient/p2' }, type: 'seealso' }] })
      expect((await write('PUT', 'Patient/p1', own)).allowed).toBe(true)
      expect((await write('PUT', 'Patient/p2', other)).allowed).toBe(false)
      expect((await write('PUT', 'Patient/p2', own)).allowed).toBe(false)
      expect((await write('PUT', 'Patient/p1', relinked)).allowed).toBe(false)
    })
  })

  describe('patch', () => {
    const jsonPatch = (ops: unknown[]) => JSON.stringify(ops)
    const fhirPathPatch = (type: string, path: string, name?: string) => JSON.stringify({
      resourceType: 'Parameters',
      parameter: [{
        name: 'operation',
        part: [
          { name: 'type', valueCode: name ? 'add' : 'replace' },
          { name: 'path', valueString: path },
          ...(name ? [{ name: 'name', valueString: name }] : []),
          { name: 'value', valueString: 'x' },
        ],
      }],
    })
    const storedOwn = { upstreamFetch: upstreamReturning([stored('Patient/p1')]) }

    it.serial('admits a patch that leaves the compartment elements alone', async () => {
      expect((await write('PATCH', 'Observation/o1', jsonPatch([{ op: 'replace', path: '/status', value: 'amended' }]), { ctx: storedOwn })).allowed).toBe(true)
      expect((await write('PATCH', 'Observation/o1', fhirPathPatch('Observation', 'Observation.status'), { ctx: storedOwn })).allowed).toBe(true)
    })

    it.serial('refuses a patch that could change the compartment reference', async () => {
      const refused = [
        jsonPatch([{ op: 'replace', path: '/subject/reference', value: 'Patient/p2' }]),
        jsonPatch([{ op: 'move', from: '/performer/0', path: '/note/0' }]),
        jsonPatch([{ op: 'replace', path: '', value: {} }]),
        fhirPathPatch('Observation', 'Observation.subject'),
        fhirPathPatch('Observation', 'Observation', 'performer'),
        fhirPathPatch('Observation', 'Observation.text | Observation.subject'),
      ]
      for (const body of refused) {
        expect((await write('PATCH', 'Observation/o1', body, { ctx: storedOwn })).allowed).toBe(false)
      }
    })

    it.serial('refuses a patch of another patient\'s resource and a patch it cannot read', async () => {
      const ok = jsonPatch([{ op: 'replace', path: '/status', value: 'amended' }])
      expect((await write('PATCH', 'Observation/o1', ok, { ctx: { upstreamFetch: upstreamReturning([stored('Patient/p2')]) } })).allowed).toBe(false)
      expect((await write('PATCH', 'Observation/o1', '<diff/>', { ctx: storedOwn })).allowed).toBe(false)
    })
  })

  describe('delete', () => {
    it.serial('admits deleting a resource in the compartment, or one that is not there', async () => {
      expect((await write('DELETE', 'Observation/o1', undefined, { ctx: { upstreamFetch: upstreamReturning([stored('Patient/p1')]) } })).allowed).toBe(true)
      expect((await write('DELETE', 'Observation/o1')).allowed).toBe(true)
    })

    it.serial('refuses deleting another patient\'s resource', async () => {
      const result = await write('DELETE', 'Observation/o1', undefined, { ctx: { upstreamFetch: upstreamReturning([stored('Patient/p2')]) } })
      expect(result.allowed).toBe(false)
      expect(result.status).toBe(403)
    })

    it.serial('refuses conditional and cascading deletes', async () => {
      const ctx = { upstreamFetch: upstreamReturning([stored('Patient/p1')]) }
      expect((await write('DELETE', 'Observation', undefined, { query: '?code=x' })).allowed).toBe(false)
      expect((await write('DELETE', 'Observation/o1', undefined, { ctx, query: '?_cascade=delete' })).allowed).toBe(false)
      expect((await write('DELETE', 'Observation/o1', undefined, { ctx, headers: { 'x-cascade': 'delete' } })).allowed).toBe(false)
    })
  })

  describe('modes', () => {
    it.serial('audit-only logs and admits what enforce would refuse', async () => {
      process.env.ROLE_BASED_FILTERING_MODE = 'audit-only'
      expect((await write('POST', 'Observation', observation('Patient/p2'))).allowed).toBe(true)
    })

    it.serial('disabled checks nothing', async () => {
      process.env.ROLE_BASED_FILTERING_MODE = 'disabled'
      const upstreamFetch = upstreamReturning([stored('Patient/p2')])
      expect((await write('DELETE', 'Observation/o1', undefined, { ctx: { upstreamFetch } })).allowed).toBe(true)
      expect(upstreamFetch).not.toHaveBeenCalled()
    })
  })

  describe('who is confined', () => {
    it.serial('confines a user who is a patient the same way', async () => {
      const ctx = { tokenPayload: { scope: 'openid user/Observation.cu', fhirUser: 'Patient/p1' } }
      expect((await write('POST', 'Observation', observation('Patient/p1'), { ctx })).allowed).toBe(true)
      expect((await write('POST', 'Observation', observation('Patient/p2'), { ctx })).allowed).toBe(false)
    })

    it.serial('leaves a practitioner with user-level scopes unconfined', async () => {
      const ctx = { tokenPayload: { scope: 'openid user/Observation.cu', fhirUser: 'Practitioner/dr-smith' } }
      expect((await write('POST', 'Observation', observation('Patient/p2'), { ctx })).allowed).toBe(true)
    })
  })
})

describe('patientCompartmentVerdict', () => {
  it('follows nested element paths and the where(resolve() is Patient) restriction', () => {
    const carePlan = { resourceType: 'CarePlan', subject: { reference: 'Patient/p1' }, activity: [{ detail: { performer: [{ reference: 'Practitioner/x' }] } }] }
    expect(patientCompartmentVerdict(carePlan, 'p1', SERVER).member).toBe(true)
    const audit = { resourceType: 'AuditEvent', agent: [{ who: { reference: 'Device/d' } }], entity: [{ what: { reference: 'Patient/p1' } }] }
    expect(patientCompartmentVerdict(audit, 'p1', SERVER).member).toBe(true)
  })

  it('ignores logical references without a literal reference', () => {
    const obs = { resourceType: 'Observation', subject: { reference: 'Patient/p1/_history/3' }, performer: [{ identifier: { value: 'x' } }] }
    expect(patientCompartmentVerdict(obs, 'p1', SERVER).member).toBe(true)
  })

  it('does not treat prototype keys as resource types', () => {
    expect(patientCompartmentVerdict({ resourceType: 'constructor' }, 'p1', SERVER).member).toBe(false)
  })
})

describe('patchRefusal', () => {
  const guarded = new Set(['id', 'subject', 'performer'])

  it('decodes JSON Pointer escapes before comparing', () => {
    expect(patchRefusal(JSON.parse('[{"op":"add","path":"/sub~1ject","value":1}]'), 'Observation', guarded)).toBeNull()
    expect(patchRefusal([{ op: 'replace', path: '/id', value: 'o2' }], 'Observation', guarded)).not.toBeNull()
  })

  it('accepts FHIRPath indexers but no functions or operators', () => {
    const op = (path: string) => ({ resourceType: 'Parameters', parameter: [{ name: 'operation', part: [{ name: 'type', valueCode: 'delete' }, { name: 'path', valueString: path }] }] })
    expect(patchRefusal(op('Observation.note[0]'), 'Observation', guarded)).toBeNull()
    expect(patchRefusal(op('Observation.note.where(true)'), 'Observation', guarded)).not.toBeNull()
    expect(patchRefusal(op('Condition.note'), 'Observation', guarded)).not.toBeNull()
  })
})
