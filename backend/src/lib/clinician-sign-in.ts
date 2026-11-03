// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { issuedFhirUser, normalizeFhirUser } from './patient-context'
import { optionalString } from './type-guards'

const CLINICIAN_TYPES: ReadonlySet<string> = new Set(['Practitioner', 'PractitionerRole'])

/** A Person sign-in issued for a Practitioner: chosen at sign-in, or resolved so by a clinician app. */
export async function signsInAsClinician(tokenPayload: Record<string, unknown>): Promise<boolean> {
  const claim = optionalString(tokenPayload.fhirUser)
  if (!claim || !normalizeFhirUser(claim).startsWith('Person/')) return false
  const issued = await issuedFhirUser(tokenPayload)
  return issued !== undefined && CLINICIAN_TYPES.has(normalizeFhirUser(issued).split('/')[0] ?? '')
}
