// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Context } from 'elysia'
import { validateToken } from '@/lib/auth'
import { extractBearerToken } from '@/lib/admin-utils'
import { resolveTokenPatientId } from '@/lib/patient-context'
import { resolveCallerIdentity } from '@/lib/caller-identity'
import { logger } from '@/lib/logger'

export type TokenPayload = Awaited<ReturnType<typeof validateToken>>

export interface PatientCaller {
  token: string
  payload: TokenPayload
  patientId: string
}

export const NO_PATIENT_CONTEXT = 'No patient context in token. Checked the patient claim, the launch '
  + 'context stored for this token, and fhirUser. Request launch/patient or '
  + 'fhirUser, and make sure the account is linked to a Patient.'

/** The patient a SMART token speaks for, taken from the token alone: never from the request. */
export async function authenticatePatientCaller(
  headers: Record<string, string | undefined>,
  set: Context['set'],
  action: string,
): Promise<PatientCaller | { error: string }> {
  const token = extractBearerToken(headers)
  if (!token) {
    set.status = 401
    return { error: 'Authorization header required' }
  }

  let payload: TokenPayload
  try {
    payload = await validateToken(token)
  } catch {
    set.status = 401
    return { error: 'Invalid or expired token' }
  }

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
