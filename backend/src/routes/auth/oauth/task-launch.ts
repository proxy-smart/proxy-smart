// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// The Task is read through the proxy's own FHIR path, so every rule guarding a FHIR read applies.

import { Elysia, type Context } from 'elysia'
import { config } from '@/config'
import { fhirResourceUrlFor, getAllServers, getServerInfoByName } from '@/lib/fhir-server-store'
import { findAppByLaunchUrl } from '@/lib/client-launch-url'
import { launchFromTask, type TaskLaunchDeps, type TaskLaunchServer, type TaskRead } from '@/lib/task-launch'
import { isRecord } from '@/lib/type-guards'
import { TaskLaunchRequest, TaskLaunchResponse, TaskLaunchError } from '@/schemas'
import { authenticateLaunchCaller, mintLaunchCode } from './launch-mint'

async function serverFor(identifier?: string): Promise<TaskLaunchServer | null> {
  const info = identifier ? await getServerInfoByName(identifier) : (await getAllServers())[0]
  return info ? { identifier: info.identifier, url: info.url, fhirBase: fhirResourceUrlFor(info) } : null
}

function failureDetail(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string') return body.error
  if (isRecord(body) && Array.isArray(body.issue)) {
    const diagnostics = body.issue.flatMap((issue) => (isRecord(issue) && typeof issue.diagnostics === 'string' ? [issue.diagnostics] : []))
    if (diagnostics.length > 0) return diagnostics.join('; ')
  }
  return `HTTP ${status}`
}

async function readTaskThroughProxy(server: TaskLaunchServer, id: string, authHeader: string): Promise<TaskRead> {
  const info = await getServerInfoByName(server.identifier)
  if (!info) return { ok: false, status: 404, detail: `FHIR server '${server.identifier}' is not configured` }

  const { proxyFHIR } = await import('@/routes/fhir')
  const set: Context['set'] = { headers: {} }
  const path = `/${config.name}/${info.identifier}/${info.metadata.fhirVersion}/Task/${encodeURIComponent(id)}`
  const body = await proxyFHIR({
    params: { server_name: info.identifier, fhir_version: info.metadata.fhirVersion },
    request: new Request(new URL(path, config.baseUrl), {
      headers: { authorization: authHeader, accept: 'application/fhir+json' },
    }),
    set,
  })

  const status = set.status === undefined ? 200 : typeof set.status === 'number' ? set.status : 502
  if (status >= 400) return { ok: false, status, detail: failureDetail(body, status) }
  if (!isRecord(body)) return { ok: false, status: 502, detail: 'the FHIR server did not answer with a resource' }
  return { ok: true, task: body }
}

export const taskLaunchRoutes = new Elysia({ tags: ['authentication'] })
  .post('/launch/task', async ({ body, headers, set }) => {
    const authenticated = await authenticateLaunchCaller(headers.authorization || headers.Authorization)
    if (!authenticated.ok) {
      set.status = 401
      return { error: authenticated.error, error_description: authenticated.error_description }
    }

    const deps: TaskLaunchDeps = {
      server: serverFor,
      readTask: readTaskThroughProxy,
      findApp: findAppByLaunchUrl,
      mint: (context) => mintLaunchCode(authenticated.caller, authenticated.authHeader, context),
    }
    const outcome = await launchFromTask(
      { task: body.task, taskReference: body.taskReference, server: body.server, authHeader: authenticated.authHeader },
      deps,
    )

    if (!outcome.ok) {
      set.status = outcome.status
      return { error: outcome.error, error_description: outcome.error_description, ...(outcome.issues && { issues: outcome.issues }) }
    }
    return outcome.result
  }, {
    body: TaskLaunchRequest,
    response: {
      200: TaskLaunchResponse,
      400: TaskLaunchError,
      401: TaskLaunchError,
      403: TaskLaunchError,
      404: TaskLaunchError,
      409: TaskLaunchError,
      502: TaskLaunchError,
      503: TaskLaunchError,
    },
    detail: {
      summary: 'Task-based App Launch',
      description: 'Acts on a SMART launch Task (task-ehr-launch or task-standalone-launch), given inline or as a reference read with the caller\'s token. An EHR launch mints a launch code from Task.for, Task.encounter and the appContext input; both answer with the registered app\'s launch URL carrying iss (and launch).',
      tags: ['authentication'],
    },
  })
