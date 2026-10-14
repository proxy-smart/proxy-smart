// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/auth — Callback Handler
 *
 * Handles the IdP callback after authentication. Validates the session,
 * gates on patient picker if needed, and forwards the auth code to the client.
 */

import { hashAuthCode } from './auth-code'
import type { LaunchSession, SmartProxyResult } from './types'
import { extractPatientFromFhirUser, getFhirUserResourceType } from './fhir-user'
import { isRedirectUriRegistered, type GetRegisteredRedirectUris } from './redirect-uri'
import { authorizationErrorRedirect } from './authorization-response'
import { chooseIdentity, isOfferedIdentity, type IdentityCandidate } from './identity-choice'
import { parseScopes } from './smart-scopes'
import { pickerRedirectUrl } from './launch-redirects'
import { continueLaunch, type LaunchStepDeps } from './encounter-selection'
import { PRACTITIONER_REQUIRED_MESSAGE, denyLaunch } from './launch-gate'

const NO_PATIENT_FOR_PERSON = 'No patient record could be found for this account, so there is nothing to open.'

/** The patient-picker bundle in a second mode; same session/code/aud plumbing. */
export const DEFAULT_IDENTITY_PICKER_PATH = '/patient-picker/?choose=identity'

export interface CallbackParams {
  state?: string
  code?: string
  error?: string
  error_description?: string
  session_state?: string
}

export interface CallbackHandlerDeps extends LaunchStepDeps {
  /**
   * Optional hook to auto-resolve the patient before showing the picker.
   * Called when the picker gate would fire. If it returns a patient ID
   * (e.g. because fhirUser is "Patient/123"), the picker is skipped. The hook may record
   * fhirUser, userSub and identityUnresolved on the session it is given; they are persisted.
   */
  autoResolvePatient?: (session: LaunchSession, params: CallbackParams) => Promise<string | null>
  /** Path for the identity picker page (default: "/patient-picker/?choose=identity") */
  identityPickerPath?: string
  /** Identities a Person links to. Injected: this package makes no FHIR calls. */
  resolveIdentities?: (session: LaunchSession) => Promise<IdentityCandidate[]>
  /**
   * Look up the redirect URIs registered for a client (RFC 6749 §3.1.2.3).
   * Defense in depth: re-validate the session's stored `clientRedirectUri`
   * before redirecting the authorization code (or an IdP error) to it, so a
   * poisoned/unvalidated session can never leak the code to an attacker host.
   * When omitted, no re-validation happens (consumers opt in).
   */
  getRegisteredRedirectUris?: GetRegisteredRedirectUris
}

export interface CallbackResult {
  result: SmartProxyResult
  /** The session that was matched (for further processing) */
  session?: LaunchSession
}

export { ACCOUNT_NOT_LINKED_MESSAGE, PRACTITIONER_REQUIRED_MESSAGE, isPractitioner } from './launch-gate'

/**
 * Process an IdP callback (smart-callback).
 *
 * Validates the session by state param, handles IdP errors by forwarding
 * them to the client, gates on patient picker if needed, then forwards
 * the auth code back to the client app.
 *
 * When `autoResolvePatient` is provided and the user's identity resolves
 * to a Patient resource (e.g. fhirUser = "Patient/123"), the picker is
 * skipped and the patient is set automatically.
 */
export async function handleCallback(
  params: CallbackParams,
  deps: CallbackHandlerDeps,
): Promise<CallbackResult> {
  const { config, store, logger } = deps

  const sessionKey = params.state
  const code = params.code
  const error = params.error

  // ── Validate session exists ───────────────────────────────────────────
  if (!sessionKey) {
    return {
      result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'Missing state parameter in callback' },
    }
  }

  const session = store.get(sessionKey)
  if (!session) {
    logger?.warn('SMART callback: session not found or expired', { state: sessionKey.slice(0, 8) + '...' })
    return {
      result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'Session expired or invalid. Please restart the authorization flow.' },
    }
  }

  // ── Re-validate the stored redirect_uri (defense in depth) ────────────
  // RFC 6749 §10.6: before forwarding the authorization code (or an IdP
  // error) to the client's redirect_uri, confirm it is STILL an exact match
  // for one registered to this client. Even though authorize already
  // validated it, a session could be poisoned or predate the fix — never
  // emit a code/error to an unvalidated host.
  if (deps.getRegisteredRedirectUris) {
    let registered: string[]
    try {
      registered = await deps.getRegisteredRedirectUris(session.clientId)
    } catch (err) {
      logger?.error('SMART callback: failed to load registered redirect URIs — refusing redirect', {
        clientId: session.clientId,
        err,
      })
      store.delete(sessionKey)
      return {
        result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'Unable to validate redirect_uri' },
      }
    }
    if (!isRedirectUriRegistered(session.clientRedirectUri, registered)) {
      logger?.warn('SMART callback: stored redirect_uri not registered for client — refusing redirect', {
        clientId: session.clientId,
        redirectUri: session.clientRedirectUri,
      })
      store.delete(sessionKey)
      return {
        result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'redirect_uri does not match a registered redirect URI for this client' },
      }
    }
  }

  // ── Handle IdP errors — forward to client as-is ───────────────────────
  if (error) {
    store.delete(sessionKey)
    const url = authorizationErrorRedirect(
      session.clientRedirectUri,
      { error, error_description: params.error_description, state: session.clientState },
      config,
    )
    return { result: { type: 'redirect', url }, session }
  }

  // ── Validate auth code present ────────────────────────────────────────
  if (!code) {
    return {
      result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'Missing authorization code in callback' },
    }
  }

  // The token exchange finds this session by the code it carries, so no other exchange for the
  // same client and redirect URI can pick up this session's launch context.
  store.update(sessionKey, { authCodeHash: hashAuthCode(code) })

  // ── Patient picker gate ───────────────────────────────────────────────
  let patientAutoResolved = false
  if (session.needsPatientPicker && !session.patient) {
    // Try auto-resolving (e.g. fhirUser is Patient/* → skip the picker)
    if (deps.autoResolvePatient) {
      const autoPatient = await deps.autoResolvePatient(session, params)
      store.update(sessionKey, {
        ...(session.fhirUser !== undefined && { fhirUser: session.fhirUser }),
        ...(session.userSub !== undefined && { userSub: session.userSub }),
        ...(session.identityUnresolved !== undefined && { identityUnresolved: session.identityUnresolved }),
      })
      if (autoPatient) {
        store.update(sessionKey, { patient: autoPatient, needsPatientPicker: false })
        patientAutoResolved = true
        logger?.info('SMART callback: auto-resolved patient from fhirUser', {
          sessionKey: sessionKey.slice(0, 8) + '...',
          patient: autoPatient,
        })
      }
    }

    // Fallback: if session already has fhirUser = "Patient/*", extract the patient directly.
    // This handles the case where autoResolvePatient fails (e.g. Keycloak admin API unreachable)
    // but the user is clearly a Patient — they must never see the picker.
    if (!patientAutoResolved && session.fhirUser) {
      const patientFromSession = extractPatientFromFhirUser(session.fhirUser)
      if (patientFromSession) {
        store.update(sessionKey, { patient: patientFromSession, needsPatientPicker: false })
        logger?.info('SMART callback: resolved patient from session fhirUser (fallback)', {
          sessionKey: sessionKey.slice(0, 8) + '...',
          patient: patientFromSession,
          fhirUser: session.fhirUser,
        })
      }
    }
  }

  // A Person names the human; resolve it here, while there is a browser to ask.
  const resolved = store.get(sessionKey) ?? session
  let identitySettled = false
  const fhirUserIsPerson = getFhirUserResourceType(session.fhirUser ?? '') === 'Person'

  if (fhirUserIsPerson && deps.resolveIdentities) {
    // A failed read must not fail the launch; it falls through to the deferral below.
    let readFailed = false
    const candidates = await deps.resolveIdentities(session).catch((error: unknown): IdentityCandidate[] => {
      readFailed = true
      logger?.warn('SMART callback: could not read the identities on the Person', {
        sessionKey: sessionKey.slice(0, 8) + '...',
        fhirUser: session.fhirUser,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    })

    const choice = chooseIdentity(candidates, session.scope, {
      patientContextEstablished: !!resolved.patient,
      ehrLaunch: !!session.ehrLaunch,
    })

    // OIDC Core 3.1.2.6: prompt=none accepts no interaction, so never a picker.
    const mayInteract = !parseScopes(session.prompt).has('none')

    if (choice.action === 'resolved') {
      // A Patient identity IS the patient context.
      const patient = extractPatientFromFhirUser(choice.identity.reference)
      store.update(sessionKey, {
        fhirUser: choice.identity.reference,
        needsIdentityPicker: false,
        ...(patient && !resolved.patient ? { patient, needsPatientPicker: false } : {}),
      })
      identitySettled = true
      logger?.info('SMART callback: resolved the launch identity from the request', {
        sessionKey: sessionKey.slice(0, 8) + '...',
        fhirUser: choice.identity.reference,
        clientId: session.clientId,
      })
    } else if (choice.action === 'choose' && mayInteract) {
      const offered = choice.candidates.map((c) => c.reference)
      store.update(sessionKey, { needsIdentityPicker: true, identityOffered: offered })
      logger?.info('SMART callback: asking which identity this launch is for', {
        sessionKey: sessionKey.slice(0, 8) + '...',
        offered,
        clientId: session.clientId,
      })
      const path = deps.identityPickerPath ?? DEFAULT_IDENTITY_PICKER_PATH
      return { result: { type: 'redirect', url: pickerRedirectUrl(config, path, sessionKey, code, session.aud) }, session }
    } else if (choice.action === 'none' && !readFailed && resolved.needsPatientPicker && !resolved.patient) {
      // The Person was read and links to nobody this launch can use, so no patient can be established.
      return {
        result: denyLaunch(sessionKey, session, {
          error: 'access_denied',
          error_description: NO_PATIENT_FOR_PERSON,
          ...(deps.accountSetupUrl && { error_uri: deps.accountSetupUrl }),
        }, deps),
        session,
      }
    }
  }

  // A Person, or a user the host could not identify, is deferred to the token endpoint, which
  // reads the verified token and refuses the grant if it still finds no patient.
  const settled = store.get(sessionKey) ?? session
  const identityUnknown = !settled.fhirUser && !!settled.identityUnresolved
  const deferPersonResolution =
    !identitySettled &&
    !!settled.needsPatientPicker &&
    !settled.patient &&
    (fhirUserIsPerson || identityUnknown)

  if (deferPersonResolution) {
    store.update(sessionKey, { needsPatientPicker: false })
    logger?.info('SMART callback: deferring patient context to the token endpoint', {
      sessionKey: sessionKey.slice(0, 8) + '...',
      clientId: session.clientId,
      fhirUser: settled.fhirUser ?? '(unresolved)',
    })
  }

  const current = store.get(sessionKey) ?? session
  logger?.info('SMART callback: continuing the launch', {
    sessionKey: sessionKey.slice(0, 8) + '...',
    clientId: current.clientId,
    hasPatient: !!current.patient,
    needsPatient: !!current.needsPatientPicker && !current.patient,
    hasEncounter: !!current.encounter,
    awaitingEncounter: !!current.needsEncounterPicker && !current.encounter,
  })

  // The patient picker for a clinician, a refusal for anyone else, then encounter and client.
  return { result: continueLaunch(sessionKey, code, deps), session: current }
}

/**
 * Handle patient picker form submission.
 *
 * Updates the session with the selected patient and redirects to the client.
 */
export function handlePatientSelect(
  params: { session?: string; code?: string; patient?: string },
  deps: CallbackHandlerDeps,
): SmartProxyResult {
  const { store, logger } = deps

  if (!params.session || !params.code || !params.patient) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Missing required parameters (session, code, patient)' }
  }

  const session = store.get(params.session)
  if (!session) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Session expired. Please restart the authorization flow.' }
  }

  // Guard: if a patient was already selected (e.g. user hit browser back), redirect idempotently
  if (!session.needsPatientPicker && session.patient) {
    logger?.info('Patient selection already completed (duplicate submission)', {
      sessionKey: params.session.slice(0, 8) + '...',
      patient: session.patient,
      clientId: session.clientId,
    })
    return continueLaunch(params.session, params.code, deps)
  }

  // Only the callback gate grants this, so a bare session key cannot name an arbitrary patient.
  if (!session.pickerAllowed) {
    logger?.warn('Patient selection refused: session was never cleared for the picker', {
      sessionKey: params.session.slice(0, 8) + '...',
      clientId: session.clientId,
    })
    return denyLaunch(params.session, session, { error: 'access_denied', error_description: PRACTITIONER_REQUIRED_MESSAGE }, deps)
  }

  store.update(params.session, { patient: params.patient, needsPatientPicker: false })

  logger?.info('Patient selected in picker', {
    sessionKey: params.session.slice(0, 8) + '...',
    patient: params.patient,
    clientId: session.clientId,
  })

  return continueLaunch(params.session, params.code, deps)
}

/** Identity picker submission. The offer check is the authorization. */
export function handleIdentitySelect(
  params: { session?: string; code?: string; identity?: string },
  deps: CallbackHandlerDeps,
): SmartProxyResult {
  const { store, logger } = deps

  if (!params.session || !params.code || !params.identity) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Missing required parameters (session, code, identity)' }
  }

  const session = store.get(params.session)
  if (!session) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Session expired. Please restart the authorization flow.' }
  }

  const sessionKey = params.session
  const code = params.code
  const forward = () => continueLaunch(sessionKey, code, deps)

  // Browser back or double submit: repeat the redirect.
  if (!session.needsIdentityPicker) {
    logger?.info('Identity selection already completed (duplicate submission)', {
      sessionKey: params.session.slice(0, 8) + '...',
      fhirUser: session.fhirUser,
      clientId: session.clientId,
    })
    return forward()
  }

  if (!isOfferedIdentity(params.identity, session.identityOffered ?? [])) {
    logger?.warn('Identity selection refused: not one this session offered', {
      sessionKey: params.session.slice(0, 8) + '...',
      requested: params.identity,
      offered: session.identityOffered ?? [],
      clientId: session.clientId,
    })
    return denyLaunch(params.session, session, { error: 'access_denied', error_description: 'That identity was not offered for this sign-in.' }, deps)
  }

  const patient = extractPatientFromFhirUser(params.identity)
  store.update(params.session, {
    fhirUser: params.identity,
    needsIdentityPicker: false,
    identityOffered: undefined,
    ...(patient ? { patient, needsPatientPicker: false } : {}),
  })

  logger?.info('Identity selected in picker', {
    sessionKey: params.session.slice(0, 8) + '...',
    fhirUser: params.identity,
    clientId: session.clientId,
  })

  return forward()
}
