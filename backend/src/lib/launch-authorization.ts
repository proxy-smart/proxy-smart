// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Who may mint a launch code for which context. A launch code establishes the patient a token is
 * confined to, so naming a patient is reserved for that patient (directly or through their Person
 * links) and for practitioners; a fhirUser may only name the caller.
 */

import { getAllServers } from './fhir-server-store'
import { normalizeFhirUser, resolveTokenPatientIdViaPerson } from './patient-context'
import { resolveFhirUserForClient } from './consent/person-resolver'

export type LaunchMintDecision = { allowed: true } | { allowed: false; reason: string }

export interface LaunchMintRequest {
  patient?: string
  fhirUser?: string
}

interface FhirServerRef {
  url: string
  identifier: string
}

export interface LaunchAuthorizationDeps {
  server: () => Promise<FhirServerRef | null>
  ownPatientId: (caller: Record<string, unknown>, server: FhirServerRef, authHeader: string) => Promise<string | null>
  practitionerOf: (fhirUser: string, server: FhirServerRef, authHeader: string) => Promise<string | undefined>
}

const defaultDeps: LaunchAuthorizationDeps = {
  server: async () => {
    const [first] = await getAllServers()
    return first ? { url: first.url, identifier: first.identifier } : null
  },
  ownPatientId: resolveTokenPatientIdViaPerson,
  practitionerOf: (fhirUser, server, authHeader) =>
    resolveFhirUserForClient(fhirUser, false, server.url, server.identifier, authHeader),
}

function bareId(reference: string): string {
  const normalized = normalizeFhirUser(reference)
  return normalized.includes('/') ? normalized.slice(normalized.indexOf('/') + 1) : normalized
}

async function isPractitioner(
  fhirUser: string | undefined,
  server: FhirServerRef,
  authHeader: string,
  deps: LaunchAuthorizationDeps,
): Promise<boolean> {
  if (!fhirUser) return false
  const normalized = normalizeFhirUser(fhirUser)
  if (normalized.startsWith('Practitioner/') || normalized.startsWith('PractitionerRole/')) return true
  if (!normalized.startsWith('Person/')) return false
  return Boolean(await deps.practitionerOf(fhirUser, server, authHeader))
}

export async function authorizeLaunchMint(
  caller: Record<string, unknown>,
  request: LaunchMintRequest,
  authHeader: string,
  deps: LaunchAuthorizationDeps = defaultDeps,
): Promise<LaunchMintDecision> {
  const callerFhirUser = typeof caller.fhirUser === 'string' ? caller.fhirUser : undefined

  if (request.fhirUser && (!callerFhirUser || normalizeFhirUser(request.fhirUser) !== normalizeFhirUser(callerFhirUser))) {
    return { allowed: false, reason: 'fhirUser must name the caller' }
  }

  if (!request.patient) return { allowed: true }

  const server = await deps.server()
  if (!server) return { allowed: false, reason: 'no FHIR server to resolve the caller against' }

  const own = await deps.ownPatientId(caller, server, authHeader)
  if (own && own === bareId(request.patient)) return { allowed: true }

  if (await isPractitioner(callerFhirUser, server, authHeader, deps)) return { allowed: true }

  return { allowed: false, reason: 'the caller may not launch for this patient' }
}
