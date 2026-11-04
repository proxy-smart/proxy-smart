// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

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

/** The picker lists every patient, so only a positively identified clinician may use it. */
export function isPractitioner(fhirUser: string | undefined): boolean {
  if (!fhirUser) return false
  const type = fhirUser.split('/').filter(Boolean).slice(-2)[0]
  return type === 'Practitioner' || type === 'PractitionerRole'
}

/** Ends the launch with an RFC 6749 §4.1.2.1 error on the session's already-validated redirect_uri. */
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

/** The picker for a clinician, a refusal for anyone else; null when no patient is missing. */
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
