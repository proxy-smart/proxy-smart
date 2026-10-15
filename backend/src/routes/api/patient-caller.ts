// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Context } from 'elysia'
import { validateToken } from '@/lib/auth'
import { extractBearerToken } from '@/lib/admin-utils'
import { normalizeFhirUser, resolveTokenPatientId } from '@/lib/patient-context'
import { bareId, resolveCallerIdentity } from '@/lib/caller-identity'
import { logger } from '@/lib/logger'

export type TokenPayload = Awaited<ReturnType<typeof validateToken>>

export interface PatientCaller {
  token: string
  payload: TokenPayload
  patientId: string
}

type Refusal = { error: string }

export const NO_PATIENT_CONTEXT = 'No patient context in token. Checked the patient claim, the launch '
  + 'context stored for this token, and fhirUser. Request launch/patient or '
  + 'fhirUser, and make sure the account is linked to a Patient.'

export const NOT_THE_PATIENT = 'Only the patient may read this. The token\'s fhirUser must be the Patient, '
  + 'or a Person linked to it; a launch that only names the patient is not enough.'

async function authenticateCaller(
  headers: Record<string, string | undefined>,
  set: Context['set'],
): Promise<{ token: string; payload: TokenPayload } | Refusal> {
  const token = extractBearerToken(headers)
  if (!token) {
    set.status = 401
    return { error: 'Authorization header required' }
  }
  try {
    return { token, payload: await validateToken(token) }
  } catch {
    set.status = 401
    return { error: 'Invalid or expired token' }
  }
}

/** The patient a SMART token speaks for, taken from the token alone: never from the request. */
export async function authenticatePatientCaller(
  headers: Record<string, string | undefined>,
  set: Context['set'],
  action: string,
): Promise<PatientCaller | Refusal> {
  const caller = await authenticateCaller(headers, set)
  if ('error' in caller) return caller
  const { token, payload } = caller

  const patientId = (await resolveTokenPatientId(payload))
    ?? (await resolveCallerIdentity(payload, `Bearer ${token}`)).patientId
  if (!patientId) {
    set.status = 400
    logger.auth.warn(`${action} refused: no patient context`, {
      clientId: payload.azp,
      hasPatientClaim: Boolean(payload.patient),
      hasFhirUser: Boolean(payload.fhirUser),
      hasJti: Boolean(payload.jti),
    })
    return { error: NO_PATIENT_CONTEXT }
  }

  return { token, payload, patientId }
}

/**
 * The caller as the patient themself: fhirUser is the Patient, or a Person linked to one.
 * A patient claim or launch context only says whose chart is open, so it never qualifies.
 */
export async function authenticateSelfPatient(
  headers: Record<string, string | undefined>,
  set: Context['set'],
  action: string,
): Promise<PatientCaller | Refusal> {
  const caller = await authenticateCaller(headers, set)
  if ('error' in caller) return caller
  const { token, payload } = caller

  const fhirUser = typeof payload.fhirUser === 'string' ? normalizeFhirUser(payload.fhirUser) : ''
  const patientId = fhirUser.startsWith('Patient/')
    ? bareId(fhirUser)
    : fhirUser.startsWith('Person/')
      ? (await resolveCallerIdentity({ fhirUser }, `Bearer ${token}`)).patientId
      : null
  if (!patientId) {
    set.status = 403
    logger.auth.warn(`${action} refused: caller is not the patient`, { clientId: payload.azp, fhirUserType: fhirUser.split('/')[0] || 'none' })
    return { error: NOT_THE_PATIENT }
  }

  return { token, payload, patientId }
}
