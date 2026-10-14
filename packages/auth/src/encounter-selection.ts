// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { ILaunchContextStore } from './stores/interface'
import type { LaunchSession, SmartProxyConfig, SmartProxyLogger, SmartProxyResult } from './types'
import { clientRedirectUrl, pickerRedirectUrl } from './launch-redirects'
import { parseScopes } from './smart-scopes'
import { denyLaunch, patientContextStep } from './launch-gate'

export const DEFAULT_ENCOUNTER_PICKER_PATH = '/patient-picker/?choose=encounter'

export interface LaunchStepDeps {
  config: SmartProxyConfig
  store: ILaunchContextStore
  logger?: SmartProxyLogger
  encounterPickerPath?: string
  /** Path for the patient picker page (default: "/patient-picker/") */
  patientPickerPath?: string
  /** Where an account linked to no FHIR identity is finished; sent as `error_uri` when it is refused. */
  accountSetupUrl?: string
}

const SESSION_EXPIRED: SmartProxyResult = {
  type: 'error',
  status: 400,
  error: 'invalid_request',
  error_description: 'Session expired. Please restart the authorization flow.',
}

/** Whether the launch stops at the encounter picker before the code goes back to the client. */
export function awaitsEncounterChoice(session: LaunchSession): boolean {
  return !!session.needsEncounterPicker
    && !!session.patient
    && !session.encounter
    && !parseScopes(session.prompt).has('none')
}

export function encounterId(reference: string): string {
  return reference.replace(/^Encounter\//, '')
}

/** The next step of a launch: the patient picker or a refusal, then the encounter picker, then the client. */
export function continueLaunch(sessionKey: string, code: string, deps: LaunchStepDeps): SmartProxyResult {
  const session = deps.store.get(sessionKey)
  if (!session) return SESSION_EXPIRED
  const patientStep = patientContextStep(sessionKey, session, code, deps)
  if (patientStep) return patientStep
  if (awaitsEncounterChoice(session)) {
    const path = deps.encounterPickerPath ?? DEFAULT_ENCOUNTER_PICKER_PATH
    return { type: 'redirect', url: pickerRedirectUrl(deps.config, path, sessionKey, code, session.aud) }
  }
  deps.store.update(sessionKey, { userSub: undefined })
  return { type: 'redirect', url: clientRedirectUrl(deps.config, session, code) }
}

/** Encounter picker submission. Membership in what the picker offered is the authorization. */
export function handleEncounterSelect(
  params: { session?: string; code?: string; encounter?: string },
  deps: LaunchStepDeps,
): SmartProxyResult {
  const { store, logger } = deps
  if (!params.session || !params.code) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Missing required parameters (session, code)' }
  }

  const session = store.get(params.session)
  if (!session) return SESSION_EXPIRED
  const forward = (): SmartProxyResult => ({ type: 'redirect', url: clientRedirectUrl(deps.config, session, params.code ?? '') })

  if (!session.needsEncounterPicker || session.encounter) return forward()

  if (!session.patient) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Select a patient before choosing an encounter.' }
  }

  const offered = session.encounterOffered ?? []
  const logContext = { sessionKey: params.session.slice(0, 8) + '...', clientId: session.clientId, patient: session.patient }

  if (!params.encounter) {
    if (offered.length > 0) {
      return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Choose one of the encounters offered for this patient.' }
    }
    store.update(params.session, { needsEncounterPicker: false, encounterOffered: undefined })
    logger?.info('Encounter selection skipped: the patient has no encounters to offer', logContext)
    return forward()
  }

  const chosen = encounterId(params.encounter)
  if (!offered.includes(chosen)) {
    logger?.warn('Encounter selection refused: not one this session offered', { ...logContext, requested: chosen })
    return denyLaunch(params.session, session, { error: 'access_denied', error_description: 'That encounter was not offered for this patient.' }, deps)
  }

  store.update(params.session, { encounter: chosen, needsEncounterPicker: false, encounterOffered: undefined })
  logger?.info('Encounter selected in picker', { ...logContext, encounter: chosen })
  return forward()
}
