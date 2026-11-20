// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Consent the proxy asks for itself, after sign-in and before any code reaches the client. The host decides whom it
 * asks and remembers each approval for the client, the resource and the scopes approved (CIMD draft §10.12).
 */

import type { LaunchSession, SmartProxyResult } from './types'
import { continueLaunch, type LaunchStepDeps } from './encounter-selection'
import { denyLaunch } from './launch-gate'

/** Consent still owed; `userId` names who gives it, absent when the callback could not tell. */
export interface PendingConsent {
  userId?: string
}

export type ConsentDecision = 'approve' | 'deny'

export interface ConsentDecisionParams {
  session?: string
  code?: string
  decision?: string
}

export interface ConsentDecisionDeps extends LaunchStepDeps {
  /** Remembers the approval; a failure is logged and the sign-in proceeds, so the user is only asked again. */
  recordConsent?: (session: LaunchSession & { consentUserId: string }) => Promise<void>
}

export const CONSENT_REQUIRED_DESCRIPTION = 'The user has not approved this client for the requested resource.'
const DECLINED_DESCRIPTION = 'The user declined to give this client access.'

const isDecision = (value: string | undefined): value is ConsentDecision => value === 'approve' || value === 'deny'

export async function handleConsentDecision(params: ConsentDecisionParams, deps: ConsentDecisionDeps): Promise<SmartProxyResult> {
  const { store, logger } = deps
  if (!params.session || !params.code || !isDecision(params.decision)) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Missing required parameters (session, code, decision)' }
  }

  const sessionKey = params.session
  const session = store.get(sessionKey)
  if (!session) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Session expired. Please restart the authorization flow.' }
  }
  const logContext = { sessionKey: sessionKey.slice(0, 8) + '...', clientId: session.clientId, resource: session.aud }

  // Browser back or a double submit: repeat where the launch already went.
  if (!session.needsConsent) return continueLaunch(sessionKey, params.code, deps)

  if (params.decision === 'deny') {
    logger?.info('Consent declined', logContext)
    return denyLaunch(sessionKey, session, { error: 'access_denied', error_description: DECLINED_DESCRIPTION }, deps)
  }

  const { consentUserId } = session
  if (consentUserId && deps.recordConsent) {
    await deps.recordConsent({ ...session, consentUserId }).catch((error: unknown) => {
      logger?.warn('Consent given but not remembered; the user will be asked again', {
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  store.update(sessionKey, { needsConsent: false, consentUserId: undefined })
  logger?.info('Consent given', { ...logContext, remembered: !!consentUserId })
  return continueLaunch(sessionKey, params.code, deps)
}
