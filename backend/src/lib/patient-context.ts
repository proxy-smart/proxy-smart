// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Which patient a token is about: the one resolution consent evaluation and compartment filtering share. */
import { tokenContextStore } from './token-context-store'
import { resolveFhirUserForClient } from './consent/person-resolver'
import { optionalString } from './type-guards'
import { tokenClientId } from './jwt-claims'

/** SMART 2.2 fhirUser types; PractitionerRole precedes Practitioner so the alternation matches it whole. */
const FHIR_USER_TYPES = ['Patient', 'PractitionerRole', 'Practitioner', 'RelatedPerson', 'Person'] as const

/** A relative or absolute fhirUser as a relative reference such as "Patient/123"; anything else unchanged. */
export function normalizeFhirUser(fhirUser: string): string {
  if (FHIR_USER_TYPES.some((t) => fhirUser.startsWith(`${t}/`))) {
    return fhirUser
  }
  const match = fhirUser.match(new RegExp(`(${FHIR_USER_TYPES.join('|')})/([a-zA-Z0-9\\-.]+)`))
  return match ? `${match[1]}/${match[2]}` : fhirUser
}

export type PatientContextSource = 'claim' | 'launch-context' | 'fhirUser' | 'person-link'

export interface ResolvedPatient {
  /** Bare id or a `Patient/id` reference — callers normalize as needed. */
  patient: string
  source: PatientContextSource
}

/** The stored launch context of this token, bound to the client it was issued to. */
function storedContext(tokenPayload: Record<string, unknown>) {
  const jti = optionalString(tokenPayload.jti)
  return jti ? tokenContextStore.get(jti, tokenClientId(tokenPayload)) : Promise.resolve(null)
}

/** The `patient` claim, then the stored launch context, then a fhirUser that names a Patient. */
export async function resolveTokenPatient(tokenPayload: Record<string, unknown>): Promise<ResolvedPatient | null> {
  const claim = tokenPayload.patient
  if (typeof claim === 'string' && claim) {
    return { patient: claim, source: 'claim' }
  }

  const stored = await storedContext(tokenPayload)
  if (stored?.patient) {
    return { patient: stored.patient, source: 'launch-context' }
  }

  const fhirUser = tokenPayload.fhirUser
  if (typeof fhirUser === 'string' && fhirUser) {
    const normalized = normalizeFhirUser(fhirUser)
    if (normalized.startsWith('Patient/')) {
      return { patient: normalized, source: 'fhirUser' }
    }
  }

  return null
}

/** The fhirUser this token was issued for: the identity chosen at sign-in, or the app's resolution of a Person. */
export async function issuedFhirUser(tokenPayload: Record<string, unknown>): Promise<string | undefined> {
  return (await storedContext(tokenPayload))?.fhirUser
}

export async function resolveTokenPatientId(tokenPayload: Record<string, unknown>): Promise<string | null> {
  const resolved = await resolveTokenPatient(tokenPayload)
  if (!resolved) return null
  return resolved.patient.includes('/') ? resolved.patient.split('/')[1] : resolved.patient
}

/** {@link resolveTokenPatient}, then a Person fhirUser followed to the Patient it links to. */
export async function resolveTokenPatientViaPerson(
  tokenPayload: Record<string, unknown>,
  server: { url: string; identifier: string },
  authHeader: string,
): Promise<ResolvedPatient | null> {
  const direct = await resolveTokenPatient(tokenPayload)
  if (direct) return direct

  const fhirUser = tokenPayload.fhirUser
  if (typeof fhirUser !== 'string' || !normalizeFhirUser(fhirUser).startsWith('Person/')) return null

  const linked = await resolveFhirUserForClient(fhirUser, true, server.url, server.identifier, authHeader)
  const patient = linked ? normalizeFhirUser(linked) : null
  return patient?.startsWith('Patient/') ? { patient, source: 'person-link' } : null
}

export async function resolveTokenPatientIdViaPerson(
  tokenPayload: Record<string, unknown>,
  server: { url: string; identifier: string },
  authHeader: string,
): Promise<string | null> {
  const resolved = await resolveTokenPatientViaPerson(tokenPayload, server, authHeader)
  if (!resolved) return null
  return resolved.patient.includes('/') ? resolved.patient.split('/')[1] : resolved.patient
}
