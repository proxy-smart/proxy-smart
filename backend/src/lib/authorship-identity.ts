// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { signsInAsClinician } from './clinician-sign-in'
import { resolveFhirUserForClient } from './consent/person-resolver'
import type { LinkedIdentity } from './fhir-authorship'

/** The identity a Person signed in under this token acts as: its Practitioner for a clinician sign-in, else its own Patient. */
export function linkedIdentityFor(tokenPayload: Record<string, unknown>, server: { url: string; identifier: string }, authHeader: string): LinkedIdentity {
  return async (person) => resolveFhirUserForClient(person, !(await signsInAsClinician(tokenPayload)), server.url, server.identifier, authHeader)
}
