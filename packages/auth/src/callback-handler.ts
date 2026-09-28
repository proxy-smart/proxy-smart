// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/auth — Callback Handler
 *
 * Handles the IdP callback after authentication. Validates the session,
 * gates on patient picker if needed, and forwards the auth code to the client.
 */

import type { LaunchSession, SmartProxyConfig, SmartProxyLogger, SmartProxyResult } from './types'
import type { ILaunchContextStore } from './stores/interface'
import { extractPatientFromFhirUser, getFhirUserResourceType } from './fhir-user'
import { isRedirectUriRegistered, type GetRegisteredRedirectUris } from './redirect-uri'
import { chooseIdentity, isOfferedIdentity, type IdentityCandidate } from './identity-choice'
import { parseScopes } from './smart-scopes'

/** The patient-picker bundle in a second mode; same session/code/aud plumbing. */
export const DEFAULT_IDENTITY_PICKER_PATH = '/patient-picker/?choose=identity'

export interface CallbackParams {
  state?: string
  code?: string
  error?: string
  error_description?: string
  session_state?: string
}

export interface CallbackHandlerDeps {
  config: SmartProxyConfig
  store: ILaunchContextStore
  logger?: SmartProxyLogger
  /** Path for the patient picker page (default: "/patient-picker/") */
  patientPickerPath?: string
  /**
   * Optional hook to auto-resolve the patient before showing the picker.
   * Called when the picker gate would fire. If it returns a patient ID
   * (e.g. because fhirUser is "Patient/123"), the picker is skipped.
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

/**
 * Add the RFC 9207 `iss` parameter to an authorization response.
 *
 * Once the proxy intercepts the callback it IS the authorization server from the
 * client's point of view, so every response it sends back — code or error — must
 * identify itself. Clients compare this against the `issuer` they recorded from
 * the proxy's authorization server metadata using simple string comparison with no
 * normalization (MCP 2026-07-28, RFC 9207 §2.4), so it must be `baseUrl` verbatim,
 * not the upstream IdP's realm issuer and not a normalized variant of either.
 *
 * RFC 9207 §2 requires it on error responses too; omitting it there is what lets a
 * mix-up attack fall back to an unattributed failure.
 */
function withIssuer(url: URL, config: SmartProxyConfig): URL {
  url.searchParams.set('iss', config.baseUrl)
  return url
}

/**
 * Whether this identity may pick a patient.
 *
 * `fhirUser` is the only identity the callback carries, so the check is on its resource TYPE. Unknown
 * or absent is NOT a practitioner — see the gate that calls this for why that direction matters.
 */
/**
 * Refusal copy, exported so the picker routes and this gate cannot drift into two
 * different explanations of the same refusal.
 */
export const PRACTITIONER_REQUIRED_MESSAGE = 'Selecting a patient requires a practitioner account.'
export const ACCOUNT_NOT_LINKED_MESSAGE =
  'This account is not yet linked to a patient record, so there is nothing to open. Finish setting up your account and sign in again.'

export function isPractitioner(fhirUser: string | undefined): boolean {
  if (!fhirUser) return false
  const type = fhirUser.split('/').filter(Boolean).slice(-2)[0]
  return type === 'Practitioner' || type === 'PractitionerRole'
}

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
  const patientPickerPath = deps.patientPickerPath ?? '/patient-picker/'

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
    const clientUrl = new URL(session.clientRedirectUri)
    clientUrl.searchParams.set('error', error)
    if (params.error_description) clientUrl.searchParams.set('error_description', params.error_description)
    if (session.clientState) clientUrl.searchParams.set('state', session.clientState)
    store.delete(sessionKey)
    return {
      result: { type: 'redirect', url: withIssuer(clientUrl, config).href },
      session,
    }
  }

  // ── Validate auth code present ────────────────────────────────────────
  if (!code) {
    return {
      result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'Missing authorization code in callback' },
    }
  }

  // ── Patient picker gate ───────────────────────────────────────────────
  let patientAutoResolved = false
  if (session.needsPatientPicker && !session.patient) {
    // Try auto-resolving (e.g. fhirUser is Patient/* → skip the picker)
    if (deps.autoResolvePatient) {
      const autoPatient = await deps.autoResolvePatient(session, params)
      if (autoPatient) {
        store.update(sessionKey, { patient: autoPatient, needsPatientPicker: false })
        patientAutoResolved = true
        logger?.info('SMART callback: auto-resolved patient from fhirUser', {
          sessionKey: sessionKey.slice(0, 8) + '...',
          patient: autoPatient,
        })
        // Fall through to "forward code to client"
      }
    }

    // Fallback: if session already has fhirUser = "Patient/*", extract the patient directly.
    // This handles the case where autoResolvePatient fails (e.g. Keycloak admin API unreachable)
    // but the user is clearly a Patient — they must never see the picker.
    if (!patientAutoResolved && session.fhirUser) {
      const patientFromSession = extractPatientFromFhirUser(session.fhirUser)
      if (patientFromSession) {
        store.update(sessionKey, { patient: patientFromSession, needsPatientPicker: false })
        patientAutoResolved = true
        logger?.info('SMART callback: resolved patient from session fhirUser (fallback)', {
          sessionKey: sessionKey.slice(0, 8) + '...',
          patient: patientFromSession,
          fhirUser: session.fhirUser,
        })
      }
    }
  }

  // A Person names the human; resolve it here, while there is a browser to ask.
  let identitySettled = false
  const fhirUserIsPerson = getFhirUserResourceType(session.fhirUser ?? '') === 'Person'

  if (fhirUserIsPerson && deps.resolveIdentities) {
    // A failed read must not fail the launch; it falls through to the deferral below.
    const candidates = await deps.resolveIdentities(session).catch((error: unknown) => {
      logger?.warn('SMART callback: could not read the identities on the Person', {
        sessionKey: sessionKey.slice(0, 8) + '...',
        fhirUser: session.fhirUser,
        error: error instanceof Error ? error.message : String(error),
      })
      return [] as IdentityCandidate[]
    })

    const choice = chooseIdentity(candidates, session.scope, {
      patientContextEstablished: !!session.patient,
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
        ...(patient && !session.patient ? { patient, needsPatientPicker: false } : {}),
      })
      identitySettled = true
      logger?.info('SMART callback: resolved the launch identity from the request', {
        sessionKey: sessionKey.slice(0, 8) + '...',
        fhirUser: choice.identity.reference,
        clientId: session.clientId,
      })
    } else if (choice.action === 'choose' && mayInteract) {
      const offered = choice.candidates.map((c) => c.reference)
      store.update(sessionKey, {
        needsIdentityPicker: true,
        identityOffered: offered,
        needsPatientPicker: false,
      })
      logger?.info('SMART callback: asking which identity this launch is for', {
        sessionKey: sessionKey.slice(0, 8) + '...',
        offered,
        clientId: session.clientId,
      })
      const pickerUrl = new URL(`${config.baseUrl}${deps.identityPickerPath ?? DEFAULT_IDENTITY_PICKER_PATH}`)
      pickerUrl.searchParams.set('session', sessionKey)
      pickerUrl.searchParams.set('code', code)
      if (session.aud) pickerUrl.searchParams.set('aud', session.aud)
      return { result: { type: 'redirect', url: pickerUrl.href }, session }
    }
  }

  // A Person, or a user the host could not identify, is deferred to the token endpoint, which
  // reads the verified token. Only a user known to have no fhirUser is refused below.
  const identityUnknown = !session.fhirUser && !!session.identityUnresolved
  const deferPersonResolution =
    !identitySettled &&
    session.needsPatientPicker &&
    !session.patient &&
    !patientAutoResolved &&
    (fhirUserIsPerson || identityUnknown)

  if (deferPersonResolution) {
    store.update(sessionKey, { needsPatientPicker: false })
    logger?.info('SMART callback: deferring patient context to the token endpoint', {
      sessionKey: sessionKey.slice(0, 8) + '...',
      clientId: session.clientId,
      fhirUser: session.fhirUser ?? '(unresolved)',
    })
  }

  // If still needs picker after auto-resolve attempt, redirect to picker UI
  if (session.needsPatientPicker && !session.patient && !patientAutoResolved && !deferPersonResolution && !identitySettled) {
    /*
     * ONLY PRACTITIONERS CHOOSE A PATIENT. The picker is a searchable directory of everyone on the
     * server, so reaching it must require positive evidence of being a clinician — not merely the
     * absence of a resolved patient. A user whose identity we could not establish fell through to
     * it, which is the same directory a patient would have seen.
     *
     * Fails closed: no practitioner fhirUser, no picker.
     */
    if (!isPractitioner(session.fhirUser)) {
      /*
       * TWO DIFFERENT SITUATIONS, TWO DIFFERENT ANSWERS. No `fhirUser` at all is not a
       * permission problem — it is a sign-up that never linked the account to a patient
       * record, and telling that person they need a practitioner account is both wrong and
       * unactionable. An identity that exists but cannot be placed on a patient (a
       * RelatedPerson carer, say) genuinely does need the clinical route. `reason` lets the
       * host present each honestly instead of matching on the description text.
       */
      const linked = !!session.fhirUser
      logger?.warn('SMART callback: refusing patient picker for a non-practitioner', {
        sessionKey: sessionKey.slice(0, 8) + '...',
        clientId: session.clientId,
        fhirUser: session.fhirUser ?? '(none)',
        reason: linked ? 'not-a-practitioner' : 'account-not-linked',
      })
      // The session rides along so the error page can name the account that was
      // refused and offer to sign out of it — without it the user is told the wrong
      // account is signed in and given no way to change that.
      return {
        session,
        result: {
          type: 'error',
          status: 403,
          error: 'access_denied',
          error_description: linked ? PRACTITIONER_REQUIRED_MESSAGE : ACCOUNT_NOT_LINKED_MESSAGE,
          reason: linked ? 'not-a-practitioner' : 'account-not-linked',
        },
      }
    }
    store.update(sessionKey, { needsPatientPicker: true, pickerAllowed: true })
    const pickerUrl = new URL(`${config.baseUrl}${patientPickerPath}`)
    pickerUrl.searchParams.set('session', sessionKey)
    pickerUrl.searchParams.set('code', code)
    if (session.aud) pickerUrl.searchParams.set('aud', session.aud)
    return {
      result: { type: 'redirect', url: pickerUrl.href },
      session,
    }
  }

  // ── Forward code to client ────────────────────────────────────────────
  store.update(sessionKey, { userSub: undefined })

  const clientUrl = new URL(session.clientRedirectUri)
  clientUrl.searchParams.set('code', code)
  if (session.clientState) clientUrl.searchParams.set('state', session.clientState)

  logger?.info('SMART callback: forwarding to client', {
    sessionKey: sessionKey.slice(0, 8) + '...',
    clientId: session.clientId,
    hasPatient: !!session.patient,
    hasEncounter: !!session.encounter,
  })

  return {
    result: { type: 'redirect', url: withIssuer(clientUrl, config).href },
    session,
  }
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
  const { config, store, logger } = deps

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
    const clientUrl = new URL(session.clientRedirectUri)
    clientUrl.searchParams.set('code', params.code)
    if (session.clientState) clientUrl.searchParams.set('state', session.clientState)
    return { type: 'redirect', url: withIssuer(clientUrl, config).href }
  }

  store.update(params.session, { patient: params.patient, needsPatientPicker: false })

  logger?.info('Patient selected in picker', {
    sessionKey: params.session.slice(0, 8) + '...',
    patient: params.patient,
    clientId: session.clientId,
  })

  const clientUrl = new URL(session.clientRedirectUri)
  clientUrl.searchParams.set('code', params.code)
  if (session.clientState) clientUrl.searchParams.set('state', session.clientState)

  return { type: 'redirect', url: withIssuer(clientUrl, config).href }
}

/** Identity picker submission. The offer check is the authorization. */
export function handleIdentitySelect(
  params: { session?: string; code?: string; identity?: string },
  deps: CallbackHandlerDeps,
): SmartProxyResult {
  const { config, store, logger } = deps

  if (!params.session || !params.code || !params.identity) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Missing required parameters (session, code, identity)' }
  }

  const session = store.get(params.session)
  if (!session) {
    return { type: 'error', status: 400, error: 'invalid_request', error_description: 'Session expired. Please restart the authorization flow.' }
  }

  const forward = () => {
    const clientUrl = new URL(session.clientRedirectUri)
    clientUrl.searchParams.set('code', params.code as string)
    if (session.clientState) clientUrl.searchParams.set('state', session.clientState)
    return { type: 'redirect' as const, url: withIssuer(clientUrl, config).href }
  }

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
    return { type: 'error', status: 403, error: 'access_denied', error_description: 'That identity was not offered for this sign-in.' }
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
