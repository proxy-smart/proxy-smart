// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Who a validated token speaks for in the FHIR data: the Patient record that is their own
 * (directly or through their Person links) and whether they act as a practitioner.
 */

import { getAllServers } from './fhir-server-store'
import { normalizeFhirUser, resolveTokenPatientIdViaPerson } from './patient-context'
import { resolveFhirUserForClient } from './consent/person-resolver'

export interface FhirServerRef {
  url: string
  identifier: string
}

export interface CallerIdentityDeps {
  server: () => Promise<FhirServerRef | null>
  ownPatientId: (caller: Record<string, unknown>, server: FhirServerRef, authHeader: string) => Promise<string | null>
  practitionerOf: (fhirUser: string, server: FhirServerRef, authHeader: string) => Promise<string | undefined>
}

export interface CallerIdentity {
  patientId: string | null
  practitioner: boolean
}

export const defaultCallerIdentityDeps: CallerIdentityDeps = {
  server: async () => {
    const [first] = await getAllServers()
    return first ? { url: first.url, identifier: first.identifier } : null
  },
  ownPatientId: resolveTokenPatientIdViaPerson,
  practitionerOf: (fhirUser, server, authHeader) =>
    resolveFhirUserForClient(fhirUser, false, server.url, server.identifier, authHeader),
}

/** A FHIR reference or bare id reduced to the bare id. */
export function bareId(reference: string): string {
  const normalized = normalizeFhirUser(reference)
  return normalized.includes('/') ? normalized.slice(normalized.indexOf('/') + 1) : normalized
}

export async function resolveCallerIdentity(
  caller: Record<string, unknown>,
  authHeader: string,
  deps: CallerIdentityDeps = defaultCallerIdentityDeps,
): Promise<CallerIdentity> {
  const server = await deps.server()
  if (!server) return { patientId: null, practitioner: false }

  const patientId = await deps.ownPatientId(caller, server, authHeader)
  const fhirUser = typeof caller.fhirUser === 'string' ? caller.fhirUser : undefined
  if (!fhirUser) return { patientId, practitioner: false }

  const normalized = normalizeFhirUser(fhirUser)
  if (normalized.startsWith('Practitioner/') || normalized.startsWith('PractitionerRole/')) {
    return { patientId, practitioner: true }
  }
  const practitioner = normalized.startsWith('Person/') && Boolean(await deps.practitionerOf(fhirUser, server, authHeader))
  return { patientId, practitioner }
}
