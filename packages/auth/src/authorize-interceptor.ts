// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type {
  AuthorizeParams,
  LaunchCodePayload,
  LaunchSession,
  SmartProxyConfig,
  SmartProxyLogger,
  SmartProxyResult,
} from './types'
import type { ILaunchContextStore } from './stores/interface'
import type { IdPAdapter } from './idp/interface'
import { isSmartLaunch, isSmartResourceRequest, isStandaloneEncounterLaunch, parseScopes, requiresPatientContext } from './smart-scopes'
import { verifyLaunchCode, toLaunchCodeOptions } from './launch-code'
import { DEFAULT_CALLBACK_PATH, isRedirectUriRegistered, type GetRegisteredRedirectUris } from './redirect-uri'
import { isCimdClientId } from './cimd'
import { authorizationErrorRedirect } from './authorization-response'
import { pkceIssue } from './pkce'

const INVALID_LAUNCH = 'The launch parameter is invalid or has expired. Launch the app again from the EHR.'
const FOREIGN_LAUNCH = 'Launch code was issued for a different client'
const UNBOUND_LAUNCH = 'Launch code is not bound to a client. Launch the app again from the EHR.'
const SPENT_LAUNCH = 'The launch parameter has already been used. Launch the app again from the EHR.'
const AUD_REQUIRED = 'aud is required: name the FHIR server the app wishes to access'
const AUD_NOT_LAUNCH_ISS = 'aud must be the iss the app was launched with'

const sameBase = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

export interface AuthorizeInterceptorDeps {
  config: SmartProxyConfig
  store: ILaunchContextStore
  idp: IdPAdapter
  logger?: SmartProxyLogger
  /** Null when the aud/resource is acceptable, otherwise the error message. */
  validateAudience?: (aud: string) => Promise<string | null>
  /** False answers 503 temporarily_unavailable. */
  isIdpReachable?: () => Promise<boolean>
  /** Registered redirect URIs (RFC 6749 §3.1.2.3); omitted, the proxy enforces no allowlist. */
  getRegisteredRedirectUris?: GetRegisteredRedirectUris
  /** Spends a launch code jti until `expiresAt` (epoch ms); false when already spent. Omitted, codes are reusable. */
  claimLaunchCode?: (jti: string, expiresAt: number) => Promise<boolean>
  /** The brokered identity provider a client's users sign in with, when the request names none. */
  preferredIdentityProvider?: (clientId: string) => Promise<string | undefined>
  /** The acr a client requires of the sign-in, asked for when the request names none. */
  requiredAcr?: (clientId: string) => Promise<string | undefined>
}

export interface AuthorizeInterceptResult {
  result: SmartProxyResult
  sessionKey?: string
  resolvedLaunchContext?: LaunchCodePayload | null
}

/** The authorize parameter naming the signing-in app to a brokered upstream identity provider. */
export const UPSTREAM_APP_PARAM = 'app_client_id'

/** The client's preferred identity provider as IdP parameters, unless the request already names one. */
async function preferredProviderHint(params: AuthorizeParams, deps: AuthorizeInterceptorDeps): Promise<Record<string, string>> {
  const hintParams = deps.idp.getIdentityProviderHintParams?.bind(deps.idp)
  if (!params.client_id || !deps.preferredIdentityProvider || !hintParams) return {}
  const alias = await deps.preferredIdentityProvider(params.client_id)
  if (!alias) return {}
  const hint = hintParams(alias)
  return Object.keys(hint).some((key) => params[key]) ? {} : hint
}

/** The client's required acr as acr_values, unless the request already asks for some. */
async function requiredAcrValues(params: AuthorizeParams, deps: AuthorizeInterceptorDeps): Promise<Record<string, string>> {
  if (!params.client_id || !deps.requiredAcr || params.acr_values) return {}
  const acr = await deps.requiredAcr(params.client_id)
  return acr ? { acr_values: acr } : {}
}

/** Validates an /authorize request, opens a callback-interception session when needed, and redirects to the IdP. */
export async function handleAuthorize(
  params: AuthorizeParams,
  deps: AuthorizeInterceptorDeps,
): Promise<AuthorizeInterceptResult> {
  const { config, store, idp, logger } = deps
  const callbackPath = config.callbackPath ?? DEFAULT_CALLBACK_PATH

  const requestedScopes = parseScopes(params.scope)
  const smartLaunch = isSmartLaunch(requestedScopes)
  const standaloneEncounter = isStandaloneEncounterLaunch(requestedScopes, !!params.launch)
  // An encounter belongs to a patient, so choosing one starts with the patient.
  const needsPatient = requiresPatientContext(requestedScopes) || standaloneEncounter

  const lookupRedirectUris = memoize(() => registeredRedirectUris(params.client_id ?? '', deps))
  const refuse = async (error: string, errorDescription: string): Promise<AuthorizeInterceptResult> => ({
    result: await refuseAuthorization(params, deps.config, lookupRedirectUris, error, errorDescription),
  })

  const pkce = pkceIssue(params)
  if (pkce) {
    logger?.warn('Authorize refused: PKCE', { clientId: params.client_id, reason: pkce })
    return refuse('invalid_request', pkce)
  }

  const aud = params.aud || params.resource
  if (!aud && isSmartResourceRequest(requestedScopes)) return refuse('invalid_request', AUD_REQUIRED)
  if (aud && deps.validateAudience) {
    const error = await deps.validateAudience(aud)
    if (error) return refuse('invalid_target', error)
  }

  if (deps.isIdpReachable) {
    const reachable = await deps.isIdpReachable()
    if (!reachable) {
      logger?.warn('IdP unreachable — returning error')
      return {
        result: { type: 'error', status: 503, error: 'temporarily_unavailable', error_description: 'Identity provider is not responding' },
      }
    }
  }

  let resolvedLaunchContext: LaunchCodePayload | null = null
  let launchClaim: { jti: string; expiresAt: number } | null = null
  if (params.launch) {
    const verified = verifyLaunchCode(params.launch, toLaunchCodeOptions(config, logger))
    if (!verified) {
      logger?.warn('EHR launch code invalid or expired, refusing the authorization request', { clientId: params.client_id })
      return refuse('invalid_request', INVALID_LAUNCH)
    }
    resolvedLaunchContext = verified.payload
    if (!resolvedLaunchContext.clientId) return { ...(await refuse('invalid_request', UNBOUND_LAUNCH)), resolvedLaunchContext }
    if (resolvedLaunchContext.clientId !== params.client_id) {
      logger?.warn('Launch code client_id mismatch', {
        expected: resolvedLaunchContext.clientId,
        actual: params.client_id,
      })
      return { ...(await refuse('invalid_request', FOREIGN_LAUNCH)), resolvedLaunchContext }
    }
    if (resolvedLaunchContext.fhirBase && (!aud || !sameBase(aud, resolvedLaunchContext.fhirBase))) {
      logger?.warn('Launch code aud mismatch', { launchedFor: resolvedLaunchContext.fhirBase, aud })
      return { ...(await refuse('invalid_target', AUD_NOT_LAUNCH_ISS)), resolvedLaunchContext }
    }
    if (deps.claimLaunchCode) {
      if (!verified.jti || !verified.expiresAt) return { ...(await refuse('invalid_request', INVALID_LAUNCH)), resolvedLaunchContext }
      launchClaim = { jti: verified.jti, expiresAt: verified.expiresAt }
    }
    logger?.info('EHR Launch code resolved', {
      patient: resolvedLaunchContext.patient,
      encounter: resolvedLaunchContext.encounter,
      intent: resolvedLaunchContext.intent,
    })
  }

  const url = new URL(idp.getAuthorizationUrl())
  const sessionKey = crypto.randomUUID()

  // SMART launches need launch context; an intercepted resource needs the proxy's own `iss` on the callback.
  const targetsInterceptedResource = !!aud && (config.interceptedResourceUrls ?? []).includes(aud)

  let shouldIntercept = (smartLaunch || targetsInterceptedResource) && !!params.redirect_uri

  // An unreadable CIMD document leaves redirect_uri validation to the IdP instead of refusing the request.
  if (shouldIntercept && params.client_id && isCimdClientId(params.client_id) && deps.getRegisteredRedirectUris) {
    const resolved = (await lookupRedirectUris()) ?? []
    if (resolved.length === 0) {
      logger?.warn('CIMD metadata document unavailable — passing through to the IdP unintercepted', {
        clientId: params.client_id,
      })
      shouldIntercept = false
    }
  }

  // Interception hides the client's redirect_uri from the IdP, so the exact match happens here, fail-closed.
  if (shouldIntercept && deps.getRegisteredRedirectUris) {
    const clientId = params.client_id || ''
    const registered = await lookupRedirectUris()
    if (!registered) {
      return {
        result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'Unable to validate redirect_uri' },
      }
    }
    if (!isRedirectUriRegistered(params.redirect_uri ?? '', registered)) {
      logger?.warn('Authorize rejected — redirect_uri not registered for client', {
        clientId,
        redirectUri: params.redirect_uri,
      })
      return {
        result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'redirect_uri does not match a registered redirect URI for this client' },
      }
    }
  }

  // Spent last, so a refused request does not burn the launch code.
  if (launchClaim && deps.claimLaunchCode && !(await deps.claimLaunchCode(launchClaim.jti, launchClaim.expiresAt))) {
    logger?.warn('EHR launch code replayed, refusing the authorization request', { clientId: params.client_id })
    return { ...(await refuse('invalid_request', SPENT_LAUNCH)), resolvedLaunchContext }
  }

  if (shouldIntercept) {
    const session: LaunchSession = {
      clientRedirectUri: params.redirect_uri ?? '',
      clientState: params.state || '',
      clientId: params.client_id || '',
      scope: params.scope || '',
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method,
      aud: aud || undefined,
      needsPatientPicker: needsPatient && !resolvedLaunchContext?.patient,
      needsEncounterPicker: standaloneEncounter,
      // Read at callback: an EHR launch means the human is here in a clinical capacity.
      ehrLaunch: !!resolvedLaunchContext,
      prompt: params.prompt,
      createdAt: Date.now(),
    }

    if (resolvedLaunchContext) {
      if (resolvedLaunchContext.patient) session.patient = resolvedLaunchContext.patient
      if (resolvedLaunchContext.encounter) session.encounter = resolvedLaunchContext.encounter
      if (resolvedLaunchContext.fhirUser) session.fhirUser = resolvedLaunchContext.fhirUser
      if (resolvedLaunchContext.intent) session.intent = resolvedLaunchContext.intent
      if (resolvedLaunchContext.smartStyleUrl) session.smartStyleUrl = resolvedLaunchContext.smartStyleUrl
      if (resolvedLaunchContext.tenant) session.tenant = resolvedLaunchContext.tenant
      if (resolvedLaunchContext.needPatientBanner !== undefined) session.needPatientBanner = resolvedLaunchContext.needPatientBanner
      if (resolvedLaunchContext.fhirContext) session.fhirContext = resolvedLaunchContext.fhirContext
      if (resolvedLaunchContext.appContext !== undefined) session.appContext = resolvedLaunchContext.appContext
      if (resolvedLaunchContext.sub) session.launchSub = resolvedLaunchContext.sub
    }

    store.set(sessionKey, session)

    logger?.info('Authorization session created — intercepting callback', {
      sessionKey: sessionKey.slice(0, 8) + '...',
      clientId: session.clientId,
      reason: smartLaunch ? 'smart-launch' : 'proxy-issued-resource',
      needsPatientPicker: session.needsPatientPicker,
      needsEncounterPicker: session.needsEncounterPicker,
      hasLaunchCode: !!resolvedLaunchContext,
    })
  }

  const notCopied = new Set(['aud', 'resource', UPSTREAM_APP_PARAM])
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && !notCopied.has(k)) {
      url.searchParams.set(k, v)
    }
  }

  const signInParams = { ...await preferredProviderHint(params, deps), ...await requiredAcrValues(params, deps) }
  for (const [k, v] of Object.entries(signInParams)) url.searchParams.set(k, v)

  // Keycloak forwards it to brokered IdPs, so it only ever comes from client_id.
  if (params.client_id) url.searchParams.set(UPSTREAM_APP_PARAM, params.client_id)

  // RFC 8707: Keycloak's resource-indicators post-processor rejects a value with a query or fragment.
  if (aud && !aud.includes('?') && !aud.includes('#')) {
    url.searchParams.set('resource', aud)
  }

  if (shouldIntercept) {
    const callbackUrl = `${config.baseUrl}${callbackPath}`
    url.searchParams.set('redirect_uri', callbackUrl)
    url.searchParams.set('state', sessionKey)
  }

  if (resolvedLaunchContext) {
    const contextParams = idp.getLaunchContextParams?.(resolvedLaunchContext)
    if (contextParams) {
      for (const [k, v] of Object.entries(contextParams)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
    }
  }

  return {
    result: { type: 'redirect', url: url.href },
    sessionKey: shouldIntercept ? sessionKey : undefined,
    resolvedLaunchContext,
  }
}

/** The client's registered redirect URIs; null when there is no lookup or it failed. */
async function registeredRedirectUris(clientId: string, deps: AuthorizeInterceptorDeps): Promise<string[] | null> {
  if (!deps.getRegisteredRedirectUris) return null
  try {
    return await deps.getRegisteredRedirectUris(clientId)
  } catch (err) {
    deps.logger?.error('Failed to load registered redirect URIs', { clientId, err })
    return null
  }
}

function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => (pending ??= load())
}

/** RFC 6749 §4.1.2.1: an error redirect only to a registered redirect_uri, otherwise a 400. */
async function refuseAuthorization(
  params: AuthorizeParams,
  config: SmartProxyConfig,
  lookupRedirectUris: () => Promise<string[] | null>,
  error: string,
  errorDescription: string,
): Promise<SmartProxyResult> {
  const refusal: SmartProxyResult = { type: 'error', status: 400, error, error_description: errorDescription }
  if (!params.client_id || !params.redirect_uri) return refusal
  const registered = await lookupRedirectUris()
  if (!registered || !isRedirectUriRegistered(params.redirect_uri, registered)) return refusal
  const url = authorizationErrorRedirect(params.redirect_uri, { error, error_description: errorDescription, state: params.state }, config)
  return { type: 'redirect', url }
}
