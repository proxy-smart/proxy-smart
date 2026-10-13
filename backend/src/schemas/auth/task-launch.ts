// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

// Open objects: a Task carries more than the launch reads, and Elysia strips undeclared props.

const open = { additionalProperties: true }

export const FhirCoding = t.Object({
  system: t.Optional(t.String()),
  code: t.Optional(t.String()),
  display: t.Optional(t.String()),
}, { ...open, title: 'FhirCoding' })

export const FhirCodeableConcept = t.Object({
  coding: t.Optional(t.Array(FhirCoding)),
  text: t.Optional(t.String()),
}, { ...open, title: 'FhirCodeableConcept' })

export const FhirReference = t.Object({
  reference: t.Optional(t.String()),
  type: t.Optional(t.String()),
  identifier: t.Optional(t.Object({}, open)),
  display: t.Optional(t.String()),
}, { ...open, title: 'FhirReference' })

export const LaunchTaskInput = t.Object({
  type: FhirCodeableConcept,
  valueUrl: t.Optional(t.String()),
  valueString: t.Optional(t.String()),
}, { ...open, title: 'LaunchTaskInput' })

export const LaunchTask = t.Object({
  resourceType: t.Literal('Task'),
  id: t.Optional(t.String()),
  status: t.String({ minLength: 1 }),
  intent: t.String({ minLength: 1 }),
  code: t.Optional(FhirCodeableConcept),
  for: t.Optional(FhirReference),
  encounter: t.Optional(FhirReference),
  input: t.Optional(t.Array(LaunchTaskInput)),
}, { ...open, title: 'LaunchTask' })
export type LaunchTaskType = Static<typeof LaunchTask>

export const TaskLaunchRequest = t.Object({
  task: t.Optional(t.Object({}, { ...open, description: 'The launch Task itself (task-ehr-launch or task-standalone-launch)' })),
  taskReference: t.Optional(t.String({ description: 'A Task on the FHIR server, as "Task/{id}", a bare id, or an absolute URL on that server' })),
  server: t.Optional(t.String({ description: 'FHIR server identifier the launch is for; defaults to the first configured server' })),
}, { title: 'TaskLaunchRequest' })
export type TaskLaunchRequestType = Static<typeof TaskLaunchRequest>

export const TaskLaunchResponse = t.Object({
  launch_type: t.Union([t.Literal('ehr'), t.Literal('standalone')], { description: 'Which launch the Task requested' }),
  launch_url: t.String({ description: 'The app launch URL to open, with iss (and launch for an EHR launch)' }),
  iss: t.String({ description: 'FHIR base URL handed to the app' }),
  client_id: t.String({ description: 'The registered SMART app the application URL belongs to' }),
  launch: t.Optional(t.String({ description: 'Signed launch code (EHR launch only)' })),
  expires_in: t.Optional(t.Number({ description: 'Seconds until the launch code expires (EHR launch only)' })),
  task: t.Optional(t.String({ description: 'The Task this launch was requested by, as "Task/{id}"' })),
  context_not_carried: t.Optional(t.Array(t.String(), {
    description: 'Task elements a standalone launch cannot hand to the app (Task.for, Task.encounter): the app chooses its own patient and encounter',
  })),
}, { title: 'TaskLaunchResponse' })
export type TaskLaunchResponseType = Static<typeof TaskLaunchResponse>

export const TaskLaunchError = t.Object({
  error: t.String(),
  error_description: t.String(),
  issues: t.Optional(t.Array(t.String(), { description: 'Every way the Task departs from its launch profile' })),
}, { title: 'TaskLaunchError' })
export type TaskLaunchErrorType = Static<typeof TaskLaunchError>
