// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/auth — establishing the patient a launch needs, or refusing it.
 *
 * SMART: when the authorization grants a patient-restricted scope, the EHR SHALL establish a
 * patient in context. A clinician chooses one in the picker; anyone else either already has
 * one or is refused, on the client's redirect_uri as RFC 6749 §4.1.2.1 describes.
 */

import type { LaunchSession, SmartProxyResult } from './types'
import type { LaunchStepDeps } from './encounter-selection'
import { authorizationErrorRedirect, type AuthorizationError } from './authorization-response'
import { pickerRedirectUrl } from './launch-redirects'
import { parseScopes } from './smart-scopes'

export const DEFAULT_PATIENT_PICKER_PATH = '/patient-picker/'

export const PRACTITIONER_REQUIRED_MESSAGE = 'Selecting a patient requires a practitioner account.'
export const ACCOUNT_NOT_LINKED_MESSAGE =
  'This account is not yet linked to a patient record, so there is nothing to open. Finish setting up your account and sign in again.'
export const PATIENT_NEEDS_INTERACTION_MESSAGE = 'A patient has to be chosen for this launch, which prompt=none does not allow.'

/**
 * Whether this identity may pick a patient. The picker is a directory of everyone on the server,
 * so it takes positive evidence of a clinician: unknown or absent is NOT a practitioner.
 */
export function isPractitioner(fhirUser: string | undefined): boolean {
  if (!fhirUser) return false
  const type = fhirUser.split('/').filter(Boolean).slice(-2)[0]
  return type === 'Practitioner' || type === 'PractitionerRole'
}

/**
 * End the launch with an authorization error on the client's redirect_uri, which authorize and
 * the callback validated against the client's registration before any session step ran.
 */
export function denyLaunch(
  sessionKey: string,
  session: LaunchSession,
  error: Omit<AuthorizationError, 'state'>,
  deps: Pick<LaunchStepDeps, 'config' | 'store' | 'logger'>,
): SmartProxyResult {
  deps.store.delete(sessionKey)
  deps.logger?.warn('Launch refused', {
    sessionKey: sessionKey.slice(0, 8) + '...',
    clientId: session.clientId,
    error: error.error,
    fhirUser: session.fhirUser ?? '(none)',
  })
  const url = authorizationErrorRedirect(session.clientRedirectUri, { ...error, state: session.clientState }, deps.config)
  return { type: 'redirect', url }
}

/**
 * The step that establishes a missing patient: the picker for a clinician, a refusal for anyone
 * else. Null when the session already has its patient or never needed one.
 */
export function patientContextStep(
  sessionKey: string,
  session: LaunchSession,
  code: string,
  deps: LaunchStepDeps,
): SmartProxyResult | null {
  if (!session.needsPatientPicker || session.patient) return null

  if (!isPractitioner(session.fhirUser)) {
    const linked = !!session.fhirUser
    return denyLaunch(sessionKey, session, {
      error: 'access_denied',
      error_description: linked ? PRACTITIONER_REQUIRED_MESSAGE : ACCOUNT_NOT_LINKED_MESSAGE,
      ...(!linked && deps.accountSetupUrl && { error_uri: deps.accountSetupUrl }),
    }, deps)
  }

  if (parseScopes(session.prompt).has('none')) {
    return denyLaunch(sessionKey, session, { error: 'interaction_required', error_description: PATIENT_NEEDS_INTERACTION_MESSAGE }, deps)
  }

  deps.store.update(sessionKey, { pickerAllowed: true })
  const path = deps.patientPickerPath ?? DEFAULT_PATIENT_PICKER_PATH
  return { type: 'redirect', url: pickerRedirectUrl(deps.config, path, sessionKey, code, session.aud) }
}
