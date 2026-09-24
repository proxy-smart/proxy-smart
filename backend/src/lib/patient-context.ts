// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Which patient a token is about — one resolution, shared by consent evaluation
 * and compartment filtering.
 *
 * The two gates used to disagree and both were wrong: the compartment rule read
 * `tokenPayload.patient`, absent on the FHIR path, and consent read the id out
 * of the request URL.
 */
import { tokenContextStore } from './token-context-store'
import { resolveFhirUserForClient } from './consent/person-resolver'

/** FHIR resource types a fhirUser claim may name, per SMART. */
const FHIR_USER_TYPES = ['Patient', 'Practitioner', 'Person', 'RelatedPerson', 'Device'] as const

/**
 * Normalize a fhirUser claim to a relative reference (e.g. "Patient/123").
 * Handles both relative references and absolute URLs per SMART spec.
 */
export function normalizeFhirUser(fhirUser: string): string {
  if (FHIR_USER_TYPES.some((t) => fhirUser.startsWith(`${t}/`))) {
    return fhirUser
  }
  const match = fhirUser.match(new RegExp(`(${FHIR_USER_TYPES.join('|')})/([a-zA-Z0-9\\-.]+)`))
  return match ? `${match[1]}/${match[2]}` : fhirUser
}

/** Where a resolved patient came from, for logs and audit. */
export type PatientContextSource = 'claim' | 'launch-context' | 'fhirUser'

export interface ResolvedPatient {
  /** Bare id or a `Patient/id` reference — callers normalize as needed. */
  patient: string
  source: PatientContextSource
}

/**
 * Most to least authoritative: the `patient` claim; the launch context by jti,
 * bound to azp so one client cannot read another's; then `fhirUser` when it
 * names a Patient (a Practitioner says who asks, not which patient).
 *
 * fhirUser matters because TokenContextStore is single-node in-memory, so the
 * first two can vanish behind a second instance.
 */
export function resolveTokenPatient(tokenPayload: Record<string, unknown>): ResolvedPatient | null {
  const claim = tokenPayload.patient
  if (typeof claim === 'string' && claim) {
    return { patient: claim, source: 'claim' }
  }

  const jti = tokenPayload.jti
  if (typeof jti === 'string' && jti) {
    const azp = tokenPayload.azp
    const stored = tokenContextStore.get(jti, typeof azp === 'string' ? azp : undefined)
    if (stored?.patient) {
      return { patient: stored.patient, source: 'launch-context' }
    }
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

/** The resolved patient as a bare FHIR id, or null. */
export function resolveTokenPatientId(tokenPayload: Record<string, unknown>): string | null {
  const resolved = resolveTokenPatient(tokenPayload)
  if (!resolved) return null
  return resolved.patient.includes('/') ? resolved.patient.split('/')[1] : resolved.patient
}

/** {@link resolveTokenPatientId}, then a Person fhirUser followed to its linked Patient. */
export async function resolveTokenPatientIdViaPerson(
  tokenPayload: Record<string, unknown>,
  server: { url: string; identifier: string },
  authHeader: string,
): Promise<string | null> {
  const direct = resolveTokenPatientId(tokenPayload)
  if (direct) return direct

  const fhirUser = tokenPayload.fhirUser
  if (typeof fhirUser !== 'string' || !fhirUser) return null

  const linked = await resolveFhirUserForClient(fhirUser, true, server.url, server.identifier, authHeader)
  return linked ? resolveTokenPatientId({ fhirUser: linked }) : null
}
