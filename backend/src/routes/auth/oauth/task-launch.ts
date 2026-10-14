// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// The Task is read through the proxy's own FHIR path, so every rule guarding a FHIR read applies.

import { Elysia } from 'elysia'
import { fhirResourceUrlFor, getAllServers, getServerInfoByName } from '@/lib/fhir-server-store'
import { findAppByLaunchUrl } from '@/lib/client-launch-url'
import { launchFromTask, type TaskLaunchDeps, type TaskLaunchServer, type TaskRead } from '@/lib/task-launch'
import { TaskLaunchRequest, TaskLaunchResponse, TaskLaunchError } from '@/schemas'
import { authenticateLaunchCaller, mintLaunchCode, readThroughProxy } from './launch-mint'

async function serverFor(identifier?: string): Promise<TaskLaunchServer | null> {
  const info = identifier ? await getServerInfoByName(identifier) : (await getAllServers())[0]
  return info ? { identifier: info.identifier, url: info.url, fhirBase: fhirResourceUrlFor(info) } : null
}

async function readTaskThroughProxy(server: TaskLaunchServer, id: string, authHeader: string): Promise<TaskRead> {
  const info = await getServerInfoByName(server.identifier)
  if (!info) return { ok: false, status: 404, detail: `FHIR server '${server.identifier}' is not configured` }
  const read = await readThroughProxy(info, 'Task', id, authHeader)
  return read.ok ? { ok: true, task: read.resource } : read
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
      description: 'Acts on a SMART launch Task (task-ehr-launch or task-standalone-launch), given inline or as a reference read with the caller\'s token. An EHR launch mints a launch code from Task.for, Task.encounter and the appContext input, bound to the app client and to iss, after checking the encounter belongs to the patient. A standalone launch carries no context: an appContext input is refused, and Task.for and Task.encounter are reported in context_not_carried. Both answer with the registered app\'s launch URL carrying iss (and launch).',
      tags: ['authentication'],
    },
  })
