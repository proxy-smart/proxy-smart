// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { bareId } from './caller-identity'
import { isFhirId } from './fhir-reference'
import { contextReference } from './launch-task-profile'
import { isRecord } from './type-guards'

export type ResourceRead = { ok: true; resource: unknown } | { ok: false; status: number; detail: string }

export type EncounterCheck = { ok: true } | { ok: false; status: number; error: string; error_description: string }

export interface LaunchServerBases {
  fhirBase: string
  url: string
}

const refuse = (status: number, error: string, error_description: string): EncounterCheck => ({ ok: false, status, error, error_description })

function readRefusal(encounter: string, status: number, detail: string): EncounterCheck {
  if (status === 401 || status === 403) return refuse(403, 'access_denied', `The caller may not read ${encounter}: ${detail}`)
  if (status === 404 || status === 410) return refuse(400, 'invalid_request', `${encounter} does not exist on the FHIR server`)
  return refuse(502, 'server_error', `Reading ${encounter} from the FHIR server failed: ${detail}`)
}

/** Launch context naming both a patient and an encounter must name the patient's own encounter. */
export async function checkEncounterOfPatient(
  patient: string,
  encounter: string,
  server: LaunchServerBases,
  read: (type: string, id: string) => Promise<ResourceRead>,
): Promise<EncounterCheck> {
  const encounterId = bareId(encounter)
  if (!isFhirId(encounterId)) return refuse(400, 'invalid_request', 'encounter must be an Encounter id or Encounter/{id}')
  const label = `Encounter/${encounterId}`

  const result = await read('Encounter', encounterId)
  if (!result.ok) return readRefusal(label, result.status, result.detail)

  const subject = isRecord(result.resource) && isRecord(result.resource.subject) ? result.resource.subject : undefined
  const reference = typeof subject?.reference === 'string' ? subject.reference : undefined
  const subjectRef = contextReference('Encounter.subject', { reference }, 'Patient', [server.fhirBase, server.url])
  if (!subjectRef.ok || subjectRef.reference !== `Patient/${bareId(patient)}`) {
    return refuse(400, 'invalid_request', `${label} is not an encounter of Patient/${bareId(patient)}`)
  }
  return { ok: true }
}
