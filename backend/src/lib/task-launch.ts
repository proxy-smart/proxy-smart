// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { TaskLaunchResponseType } from '@/schemas/auth/task-launch'
import type { RegisteredAppLookup } from './client-launch-url'
import type { LaunchMintContext, LaunchMintOutcome } from './launch-authorization'
import { contextReference, readLaunchTask, type LaunchTaskRequest } from './launch-task-profile'
import { isFhirId } from './fhir-reference'

export type { LaunchMintContext } from './launch-authorization'

export interface TaskLaunchServer {
  identifier: string
  url: string
  fhirBase: string
}

export type TaskRead = { ok: true; task: unknown } | { ok: false; status: number; detail: string }

export interface TaskLaunchDeps {
  server: (identifier?: string) => Promise<TaskLaunchServer | null>
  readTask: (server: TaskLaunchServer, id: string, authHeader: string) => Promise<TaskRead>
  findApp: (launchUrl: string) => Promise<RegisteredAppLookup>
  mint: (context: LaunchMintContext) => Promise<LaunchMintOutcome>
}

export interface TaskLaunchInput {
  task?: unknown
  taskReference?: string
  server?: string
  authHeader: string
}

export interface TaskLaunchFailure {
  ok: false
  status: number
  error: string
  error_description: string
  issues?: string[]
}

export type TaskLaunchOutcome = { ok: true; result: TaskLaunchResponseType } | TaskLaunchFailure

// FHIR treats an entered-in-error resource as never having existed.
const WITHDRAWN_STATUSES = new Set(['cancelled', 'entered-in-error'])

function fail(status: number, error: string, error_description: string, issues?: string[]): TaskLaunchFailure {
  return { ok: false, status, error, error_description, ...(issues && { issues }) }
}

function readFailure(status: number, detail: string): TaskLaunchFailure {
  if (status === 401) return fail(401, 'unauthorized', `The FHIR server did not accept the caller's token: ${detail}`)
  if (status === 403) return fail(403, 'access_denied', `The caller may not read this Task: ${detail}`)
  if (status === 404 || status === 410) return fail(404, 'not_found', `No such Task on the FHIR server: ${detail}`)
  return fail(502, 'server_error', `Reading the Task from the FHIR server failed: ${detail}`)
}

async function obtainTask(input: TaskLaunchInput, server: TaskLaunchServer, deps: TaskLaunchDeps): Promise<{ ok: true; task: unknown; id?: string } | TaskLaunchFailure> {
  if (input.taskReference === undefined) return { ok: true, task: input.task }

  const literal = isFhirId(input.taskReference) ? `Task/${input.taskReference}` : input.taskReference
  const ref = contextReference('taskReference', { reference: literal }, 'Task', [server.fhirBase, server.url])
  if (!ref.ok) return fail(400, 'invalid_request', ref.issue)

  const id = ref.reference.slice('Task/'.length)
  const read = await deps.readTask(server, id, input.authHeader)
  return read.ok ? { ok: true, task: read.task, id } : readFailure(read.status, read.detail)
}

function launchUrlFor(appUrl: string, iss: string, launch?: string): string {
  const url = new URL(appUrl)
  url.searchParams.set('iss', iss)
  if (launch) url.searchParams.set('launch', launch)
  return url.href
}

async function ehrLaunch(task: LaunchTaskRequest, server: TaskLaunchServer, clientId: string, deps: TaskLaunchDeps): Promise<TaskLaunchOutcome> {
  const bases = [server.fhirBase, server.url]
  const patient = task.patient && contextReference('Task.for', task.patient, 'Patient', bases)
  const encounter = task.encounter && contextReference('Task.encounter', task.encounter, 'Encounter', bases)
  const issues = [patient, encounter].flatMap((ref) => (ref && !ref.ok ? [ref.issue] : []))
  if (issues.length > 0) return fail(400, 'invalid_request', 'The Task names launch context this server cannot provide', issues)

  const minted = await deps.mint({
    ...(patient?.ok && { patient: patient.reference }),
    ...(encounter?.ok && { encounter: encounter.reference }),
    ...(task.appContext !== undefined && { appContext: task.appContext }),
    clientId,
    fhirBase: server.fhirBase,
  })
  if (!minted.ok) return minted

  return {
    ok: true,
    result: {
      launch_type: 'ehr',
      launch_url: launchUrlFor(task.appUrl, server.fhirBase, minted.launch),
      iss: server.fhirBase,
      client_id: clientId,
      launch: minted.launch,
      expires_in: minted.expiresIn,
    },
  }
}

/** A standalone launch hands the app only `iss`; the app establishes its own context, so none is carried. */
function standaloneLaunch(task: LaunchTaskRequest, server: TaskLaunchServer, clientId: string): TaskLaunchOutcome {
  if (task.appContext !== undefined) {
    return fail(400, 'invalid_request', 'A standalone launch has no launch parameter to carry appContext to the app; request launch-app-ehr instead')
  }
  const notCarried = [task.patient && 'Task.for', task.encounter && 'Task.encounter'].filter((element): element is string => !!element)
  return {
    ok: true,
    result: {
      launch_type: 'standalone',
      launch_url: launchUrlFor(task.appUrl, server.fhirBase),
      iss: server.fhirBase,
      client_id: clientId,
      ...(notCarried.length > 0 && { context_not_carried: notCarried }),
    },
  }
}

export async function launchFromTask(input: TaskLaunchInput, deps: TaskLaunchDeps): Promise<TaskLaunchOutcome> {
  if ((input.task === undefined) === (input.taskReference === undefined)) {
    return fail(400, 'invalid_request', 'Give either the Task itself (task) or a reference to it (taskReference)')
  }

  const server = await deps.server(input.server)
  if (!server) {
    return fail(404, 'invalid_request', input.server ? `FHIR server '${input.server}' is not configured` : 'No FHIR server is configured')
  }

  const obtained = await obtainTask(input, server, deps)
  if (!obtained.ok) return obtained

  const read = readLaunchTask(obtained.task)
  if (!read.ok) return fail(400, 'invalid_request', 'The Task does not conform to a SMART launch Task profile', read.issues)
  const task = read.task
  if (WITHDRAWN_STATUSES.has(task.status)) return fail(409, 'invalid_request', `The Task is ${task.status}; there is nothing to launch`)

  const found = await deps.findApp(task.appUrl)
  if (found.status === 'unavailable') return fail(503, 'temporarily_unavailable', 'The registered SMART apps cannot be read right now')
  if (found.status === 'ambiguous') return fail(400, 'invalid_request', `The application URL is registered by several apps (${found.clientIds.join(', ')})`)
  if (found.status === 'absent') return fail(400, 'invalid_request', 'The application URL is not the launch URL of a registered SMART app')

  const taskId = obtained.id ?? task.id
  const outcome = task.kind === 'ehr'
    ? await ehrLaunch(task, server, found.app.clientId, deps)
    : standaloneLaunch(task, server, found.app.clientId)
  return outcome.ok && taskId ? { ok: true, result: { ...outcome.result, task: `Task/${taskId}` } } : outcome
}
