// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { readLaunchTask, SMART_CODES_SYSTEM } from '../src/lib/launch-task-profile'
import { launchFromTask, type TaskLaunchDeps, type TaskLaunchServer, type LaunchMintContext } from '../src/lib/task-launch'

const APP_URL = 'https://app.example.org/launch'
const FHIR_BASE = 'https://proxy.example.org/proxy/hapi/R4'
const UPSTREAM = 'https://hapi.internal/fhir'

const coding = (code: string) => ({ coding: [{ system: SMART_CODES_SYSTEM, code }] })
const appInput = (url = APP_URL) => ({ type: coding('smartonfhir-application'), valueUrl: url })
const contextInput = (value = '{"field1":"value"}') => ({ type: coding('smartonfhir-appcontext'), valueString: value })

function ehrTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'Task',
    id: 'task-for-ehr-launch',
    status: 'requested',
    intent: 'proposal',
    code: coding('launch-app-ehr'),
    for: { reference: 'Patient/123' },
    encounter: { reference: 'Encounter/456' },
    input: [appInput(), contextInput()],
    ...overrides,
  }
}

function standaloneTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...ehrTask({ code: coding('launch-app-standalone'), input: [appInput()] }), ...overrides }
}

function issuesOf(task: unknown): string[] {
  const result = readLaunchTask(task)
  return result.ok ? [] : result.issues
}

describe('a launch Task is read against its profile', () => {
  it('reads the task-ehr-launch example from the spec', () => {
    const result = readLaunchTask(ehrTask())
    expect(result).toEqual({
      ok: true,
      task: {
        kind: 'ehr',
        id: 'task-for-ehr-launch',
        status: 'requested',
        appUrl: APP_URL,
        appContext: '{"field1":"value"}',
        patient: { reference: 'Patient/123' },
        encounter: { reference: 'Encounter/456' },
      },
    })
  })

  it('reads the task-standalone-launch example from the spec', () => {
    const result = readLaunchTask(standaloneTask())
    expect(result.ok && result.task.kind).toBe('standalone')
    expect(result.ok && result.task.appUrl).toBe(APP_URL)
  })

  it('accepts inputs beyond the two named slices, since the slicing is open', () => {
    const extra = { type: { coding: [{ system: 'urn:example', code: 'note' }] }, valueString: 'x' }
    expect(readLaunchTask(ehrTask({ input: [extra, appInput()] })).ok).toBe(true)
  })

  it('accepts a code that carries other codings next to the pattern one', () => {
    const code = { coding: [{ system: 'urn:local', code: 'open-app' }, { system: SMART_CODES_SYSTEM, code: 'launch-app-ehr' }], text: 'Open' }
    expect(readLaunchTask(ehrTask({ code })).ok).toBe(true)
  })

  it('refuses a resource that is not a Task', () => {
    expect(issuesOf({ ...ehrTask(), resourceType: 'ServiceRequest' }).length).toBeGreaterThan(0)
    expect(issuesOf('Task').length).toBeGreaterThan(0)
  })

  it('refuses a Task without the status or intent the base resource requires', () => {
    const { status: _status, ...noStatus } = ehrTask()
    const { intent: _intent, ...noIntent } = ehrTask()
    expect(issuesOf(noStatus).length).toBeGreaterThan(0)
    expect(issuesOf(noIntent).length).toBeGreaterThan(0)
  })

  it('refuses a code outside the SMART launch types', () => {
    expect(issuesOf(ehrTask({ code: { coding: [{ system: 'urn:other', code: 'launch-app-ehr' }] } }))).toContain(
      `Task.code must carry ${SMART_CODES_SYSTEM}#launch-app-ehr or #launch-app-standalone`,
    )
    expect(issuesOf(ehrTask({ code: undefined })).length).toBeGreaterThan(0)
  })

  it('requires exactly one application URL input, as a url', () => {
    expect(issuesOf(ehrTask({ input: [contextInput()] }))).toContain('Task.input must carry exactly one smartonfhir-application input')
    expect(issuesOf(ehrTask({ input: [appInput(), appInput('https://other.example.org/')] }))).toContain(
      'Task.input must carry exactly one smartonfhir-application input',
    )
    expect(issuesOf(ehrTask({ input: [{ type: coding('smartonfhir-application'), valueString: APP_URL }] }))).toContain(
      'Task.input:launchurl must be a valueUrl',
    )
    expect(issuesOf(ehrTask({ input: [] })).length).toBeGreaterThan(0)
  })

  it('refuses an application URL that is not absolute http(s)', () => {
    expect(issuesOf(ehrTask({ input: [appInput('/relative/app')] }))).toContain('Task.input:launchurl must be an absolute http(s) URL')
    expect(issuesOf(ehrTask({ input: [appInput('javascript:alert(1)')] }))).toContain('Task.input:launchurl must be an absolute http(s) URL')
  })

  it('allows at most one appContext input, as a string', () => {
    expect(issuesOf(ehrTask({ input: [appInput(), contextInput(), contextInput()] }))).toContain(
      'Task.input may carry at most one smartonfhir-appcontext input',
    )
    expect(issuesOf(ehrTask({ input: [appInput(), { type: coding('smartonfhir-appcontext'), valueUrl: APP_URL }] }))).toContain(
      'Task.input:launchcontext must be a valueString',
    )
  })
})

interface Calls {
  read: { server: string; id: string; authHeader: string }[]
  mint: LaunchMintContext[]
}

const server: TaskLaunchServer = { identifier: 'hapi', url: UPSTREAM, fhirBase: FHIR_BASE }

function deps(overrides: Partial<TaskLaunchDeps> = {}): { deps: TaskLaunchDeps; calls: Calls } {
  const calls: Calls = { read: [], mint: [] }
  return {
    calls,
    deps: {
      server: async (identifier) => (identifier === undefined || identifier === 'hapi' ? server : null),
      readTask: async (target, id, authHeader) => {
        calls.read.push({ server: target.identifier, id, authHeader })
        return { ok: true, task: ehrTask({ id }) }
      },
      findApp: async (url) => (url === APP_URL ? { status: 'found', app: { clientId: 'cds-app', launchUrl: APP_URL } } : { status: 'absent' }),
      mint: async (context) => {
        calls.mint.push(context)
        return { ok: true, launch: 'signed-launch-code', expiresIn: 300 }
      },
      ...overrides,
    },
  }
}

describe('launching an app from a Task', () => {
  it('mints a launch code from the Task context and hands the app iss and launch', async () => {
    const { deps: d, calls } = deps()
    const outcome = await launchFromTask({ task: ehrTask(), authHeader: 'Bearer t' }, d)

    expect(calls.mint).toEqual([
      { patient: 'Patient/123', encounter: 'Encounter/456', appContext: '{"field1":"value"}', clientId: 'cds-app', fhirBase: FHIR_BASE },
    ])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toMatchObject({ launch_type: 'ehr', client_id: 'cds-app', iss: FHIR_BASE, launch: 'signed-launch-code', expires_in: 300 })
    const url = new URL(outcome.result.launch_url)
    expect(`${url.origin}${url.pathname}`).toBe(APP_URL)
    expect(url.searchParams.get('iss')).toBe(FHIR_BASE)
    expect(url.searchParams.get('launch')).toBe('signed-launch-code')
  })

  it('keeps a query the application URL already carries', async () => {
    const appUrl = `${APP_URL}?tenant=a`
    const { deps: d } = deps({ findApp: async () => ({ status: 'found', app: { clientId: 'cds-app', launchUrl: appUrl } }) })
    const outcome = await launchFromTask({ task: ehrTask({ input: [appInput(appUrl)] }), authHeader: 'Bearer t' }, d)
    expect(outcome.ok && new URL(outcome.result.launch_url).searchParams.get('tenant')).toBe('a')
  })

  it('resolves absolute context references on the server the launch is for', async () => {
    const { deps: d, calls } = deps()
    const task = ehrTask({ for: { reference: `${FHIR_BASE}/Patient/123` }, encounter: { reference: `${UPSTREAM}/Encounter/456/_history/2` } })
    expect((await launchFromTask({ task, authHeader: 'Bearer t' }, d)).ok).toBe(true)
    expect(calls.mint[0]).toMatchObject({ patient: 'Patient/123', encounter: 'Encounter/456' })
  })

  it('refuses context that lives on another server', async () => {
    const { deps: d, calls } = deps()
    const outcome = await launchFromTask({ task: ehrTask({ for: { reference: 'https://example.org/fhir/Patient/123' } }), authHeader: 'Bearer t' }, d)
    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'invalid_request' })
    expect(calls.mint).toEqual([])
  })

  it('refuses a Task.for that is not a Patient, and an encounter that is not an Encounter', async () => {
    const { deps: d } = deps()
    expect(await launchFromTask({ task: ehrTask({ for: { reference: 'Group/1' } }), authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 400 })
    expect(await launchFromTask({ task: ehrTask({ encounter: { reference: 'Patient/1' } }), authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 400 })
    expect(await launchFromTask({ task: ehrTask({ for: { identifier: { value: 'mrn-1' } } }), authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 400 })
  })

  it('launches with no patient when the Task names none', async () => {
    const { deps: d, calls } = deps()
    const { for: _for, encounter: _encounter, ...task } = ehrTask({ input: [appInput()] })
    expect((await launchFromTask({ task, authHeader: 'Bearer t' }, d)).ok).toBe(true)
    expect(calls.mint).toEqual([{ clientId: 'cds-app', fhirBase: FHIR_BASE }])
  })

  it('only launches applications registered with the proxy', async () => {
    const { deps: d, calls } = deps()
    const outcome = await launchFromTask({ task: ehrTask({ input: [appInput('https://evil.example.org/')] }), authHeader: 'Bearer t' }, d)
    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'invalid_request' })
    expect(calls.mint).toEqual([])
  })

  it('refuses a URL several registered apps share', async () => {
    const { deps: d } = deps({ findApp: async () => ({ status: 'ambiguous', clientIds: ['a', 'b'] }) })
    expect(await launchFromTask({ task: ehrTask(), authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 400, error: 'invalid_request' })
  })

  it('says so when the app directory cannot be reached', async () => {
    const { deps: d } = deps({ findApp: async () => ({ status: 'unavailable', reason: 'down' }) })
    expect(await launchFromTask({ task: ehrTask(), authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 503, error: 'temporarily_unavailable' })
  })

  it('passes on a refusal to mint the launch code', async () => {
    const { deps: d } = deps({ mint: async () => ({ ok: false, status: 403, error: 'access_denied', error_description: 'no' }) })
    expect(await launchFromTask({ task: ehrTask(), authHeader: 'Bearer t' }, d)).toEqual({ ok: false, status: 403, error: 'access_denied', error_description: 'no' })
  })

  it('does not act on a Task that was cancelled or entered in error', async () => {
    const { deps: d, calls } = deps()
    for (const status of ['cancelled', 'entered-in-error']) {
      expect(await launchFromTask({ task: ehrTask({ status }), authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 409 })
    }
    expect(calls.mint).toEqual([])
  })

  it('reports every profile violation of an invalid Task', async () => {
    const { deps: d } = deps()
    const outcome = await launchFromTask({ task: ehrTask({ code: undefined, input: [contextInput()] }), authHeader: 'Bearer t' }, d)
    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'invalid_request' })
    expect(!outcome.ok && outcome.issues?.length).toBe(2)
  })

  it('opens a standalone launch at the app with iss only, minting nothing', async () => {
    const { deps: d, calls } = deps()
    const outcome = await launchFromTask({ task: standaloneTask(), authHeader: 'Bearer t' }, d)
    expect(calls.mint).toEqual([])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.launch_type).toBe('standalone')
    expect(outcome.result.launch).toBeUndefined()
    const url = new URL(outcome.result.launch_url)
    expect(url.searchParams.get('iss')).toBe(FHIR_BASE)
    expect(url.searchParams.has('launch')).toBe(false)
  })

  it('refuses a standalone Task carrying appContext, which only a launch code can deliver', async () => {
    const { deps: d, calls } = deps()
    const outcome = await launchFromTask({ task: standaloneTask({ input: [appInput(), contextInput()] }), authHeader: 'Bearer t' }, d)
    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'invalid_request' })
    expect(!outcome.ok && outcome.error_description).toContain('launch-app-ehr')
    expect(calls.mint).toEqual([])
  })

  it('says which Task context a standalone launch does not carry to the app', async () => {
    const { deps: d } = deps()
    const outcome = await launchFromTask({ task: standaloneTask(), authHeader: 'Bearer t' }, d)
    expect(outcome.ok && outcome.result.context_not_carried).toEqual(['Task.for', 'Task.encounter'])

    const { for: _for, encounter: _encounter, ...bare } = standaloneTask()
    const plain = await launchFromTask({ task: bare, authHeader: 'Bearer t' }, d)
    expect(plain.ok && plain.result.context_not_carried).toBeUndefined()
  })

  it('reads a referenced Task from the server with the caller\'s authorization', async () => {
    const { deps: d, calls } = deps()
    for (const taskReference of ['Task/t-1', 't-1', `${FHIR_BASE}/Task/t-1`]) {
      const outcome = await launchFromTask({ taskReference, server: 'hapi', authHeader: 'Bearer caller' }, d)
      expect(outcome.ok && outcome.result.task).toBe('Task/t-1')
    }
    expect(calls.read).toEqual(Array(3).fill({ server: 'hapi', id: 't-1', authHeader: 'Bearer caller' }))
  })

  it('refuses a Task reference that names another resource or server', async () => {
    const { deps: d, calls } = deps()
    for (const taskReference of ['Patient/1', 'https://example.org/fhir/Task/t-1', 'Task/../x']) {
      expect(await launchFromTask({ taskReference, authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 400 })
    }
    expect(calls.read).toEqual([])
  })

  it('passes on the server refusing or not finding the Task', async () => {
    const { deps: d } = deps({ readTask: async () => ({ ok: false, status: 403, detail: 'scope' }) })
    expect(await launchFromTask({ taskReference: 'Task/t-1', authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 403, error: 'access_denied' })
    const { deps: missing } = deps({ readTask: async () => ({ ok: false, status: 404, detail: 'gone' }) })
    expect(await launchFromTask({ taskReference: 'Task/t-1', authHeader: 'Bearer t' }, missing)).toMatchObject({ ok: false, status: 404, error: 'not_found' })
  })

  it('needs exactly one of an inline Task and a reference', async () => {
    const { deps: d } = deps()
    expect(await launchFromTask({ authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 400 })
    expect(await launchFromTask({ task: ehrTask(), taskReference: 'Task/1', authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses a server that is not configured', async () => {
    const { deps: d } = deps()
    expect(await launchFromTask({ task: ehrTask(), server: 'nope', authHeader: 'Bearer t' }, d)).toMatchObject({ ok: false, status: 404 })
  })
})
