// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Who may mint a launch code for which context. A launch code establishes the patient a token is
 * confined to, so naming a patient is reserved for that patient (directly or through their Person
 * links) and for practitioners; a fhirUser may only name the caller.
 */

import { normalizeFhirUser } from './patient-context'
import { bareId, defaultCallerIdentityDeps, resolveCallerIdentity, type CallerIdentityDeps } from './caller-identity'

export type LaunchMintDecision = { allowed: true } | { allowed: false; reason: string }

export interface LaunchMintRequest {
  patient?: string
  fhirUser?: string
}

export async function authorizeLaunchMint(
  caller: Record<string, unknown>,
  request: LaunchMintRequest,
  authHeader: string,
  deps: CallerIdentityDeps = defaultCallerIdentityDeps,
): Promise<LaunchMintDecision> {
  const callerFhirUser = typeof caller.fhirUser === 'string' ? caller.fhirUser : undefined

  if (request.fhirUser && (!callerFhirUser || normalizeFhirUser(request.fhirUser) !== normalizeFhirUser(callerFhirUser))) {
    return { allowed: false, reason: 'fhirUser must name the caller' }
  }

  if (!request.patient) return { allowed: true }

  const identity = await resolveCallerIdentity(caller, authHeader, deps)
  if (identity.patientId && identity.patientId === bareId(request.patient)) return { allowed: true }
  if (identity.practitioner) return { allowed: true }

  return { allowed: false, reason: 'the caller may not launch for this patient' }
}
