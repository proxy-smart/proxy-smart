// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/auth — Authorize Interceptor
 *
 * Inspects /authorize requests to detect SMART launches, creates sessions,
 * rewrites redirect_uri to the proxy callback, and resolves EHR launch codes.
 *
 * Returns a framework-agnostic SmartProxyResult — the consumer (Elysia, Express, etc.)
 * maps it to their framework's response mechanism.
 */

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
import { isSmartLaunch, isStandaloneLaunch, parseScopes } from './smart-scopes'
import { verifyLaunchCode, toLaunchCodeOptions } from './launch-code'
import { DEFAULT_CALLBACK_PATH, isRedirectUriRegistered, type GetRegisteredRedirectUris } from './redirect-uri'
import { isCimdClientId } from './cimd'

export interface AuthorizeInterceptorDeps {
  config: SmartProxyConfig
  store: ILaunchContextStore
  idp: IdPAdapter
  logger?: SmartProxyLogger
  /** Validate aud/resource parameter. Return null if valid, or an error message if invalid. */
  validateAudience?: (aud: string) => Promise<string | null>
  /** Check if IdP is reachable. Return false to serve a friendly error page. */
  isIdpReachable?: () => Promise<boolean>
  /**
   * Look up the redirect URIs registered for a client (RFC 6749 §3.1.2.3).
   * When provided, the requested `redirect_uri` MUST exactly match one of the
   * returned URIs or the authorize request is rejected — preventing
   * authorization-code theft via an attacker-controlled redirect_uri.
   * When omitted, no allowlist enforcement happens (consumers opt in).
   */
  getRegisteredRedirectUris?: GetRegisteredRedirectUris
}

export interface AuthorizeInterceptResult {
  result: SmartProxyResult
  /** The session key if a session was created (for testing/monitoring) */
  sessionKey?: string
  /** Resolved launch context if an EHR launch code was present and valid */
  resolvedLaunchContext?: LaunchCodePayload | null
}

/**
 * Process an /authorize request.
 *
 * Detects SMART scopes, resolves EHR launch codes, creates sessions for
 * callback interception, and produces a redirect URL to the IdP.
 */
export async function handleAuthorize(
  params: AuthorizeParams,
  deps: AuthorizeInterceptorDeps,
): Promise<AuthorizeInterceptResult> {
  const { config, store, idp, logger } = deps
  const callbackPath = config.callbackPath ?? DEFAULT_CALLBACK_PATH

  const requestedScopes = parseScopes(params.scope)
  const smartLaunch = isSmartLaunch(requestedScopes)
  const standaloneLaunch = isStandaloneLaunch(requestedScopes, !!params.launch)

  // ── Audience validation ───────────────────────────────────────────────
  const aud = params.aud || params.resource
  if (aud && deps.validateAudience) {
    const error = await deps.validateAudience(aud)
    if (error) {
      return {
        result: { type: 'error', status: 400, error: 'invalid_request', error_description: error },
      }
    }
  }

  // ── IdP reachability check ────────────────────────────────────────────
  if (deps.isIdpReachable) {
    const reachable = await deps.isIdpReachable()
    if (!reachable) {
      logger?.warn('IdP unreachable — returning error')
      return {
        result: { type: 'error', status: 503, error: 'temporarily_unavailable', error_description: 'Identity provider is not responding' },
      }
    }
  }

  // ── EHR Launch code resolution ────────────────────────────────────────
  let resolvedLaunchContext: LaunchCodePayload | null = null
  if (params.launch) {
    const result = verifyLaunchCode(params.launch, toLaunchCodeOptions(config, logger))
    if (result) {
      resolvedLaunchContext = result.payload
      // Validate client_id audience restriction
      if (resolvedLaunchContext.clientId && params.client_id && resolvedLaunchContext.clientId !== params.client_id) {
        logger?.warn('Launch code client_id mismatch', {
          expected: resolvedLaunchContext.clientId,
          actual: params.client_id,
        })
        return {
          result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'Launch code was issued for a different client' },
          resolvedLaunchContext,
        }
      }
      logger?.info('EHR Launch code resolved', {
        patient: resolvedLaunchContext.patient,
        encounter: resolvedLaunchContext.encounter,
        intent: resolvedLaunchContext.intent,
      })
    } else {
      logger?.warn('EHR Launch code invalid or expired, proceeding without launch context')
    }
  }

  // ── Build IdP authorization URL ───────────────────────────────────────
  const idpAuthUrl = idp.getAuthorizationUrl()
  const url = new URL(idpAuthUrl)

  const sessionKey = crypto.randomUUID()

  // Intercept for SMART launches (they need launch context and the picker) and for
  // any request naming a resource the proxy is the discovered authorization server
  // for — the latter so the callback can carry the proxy's own `iss`. See
  // SmartProxyConfig.interceptedResourceUrls.
  const targetsInterceptedResource = !!aud && (config.interceptedResourceUrls ?? []).includes(aud)

  let shouldIntercept = (smartLaunch || targetsInterceptedResource) && !!params.redirect_uri

  // ── Only intercept what we can validate ───────────────────────────────
  // Interception rewrites redirect_uri to the proxy callback, which takes the
  // RFC 6749 §10.6 check away from the IdP and gives it to us. We may only do
  // that when we can actually perform it.
  //
  // For a CIMD client (`client_id` is an https URL) the allowlist lives in a
  // document on the CLIENT'S OWN HOST, and fetching it can fail for reasons that
  // say nothing about the request: a bot-protection interstitial in front of that
  // host, egress restrictions, an outage. Treating an unreadable document as "no
  // registered URIs" would reject a legitimate authorize request that, before any
  // of this existed, passed through to the IdP and worked — the IdP resolves CIMD
  // itself and can validate what we could not read.
  //
  // So: resolve first, and only take over when the document actually answered.
  // Otherwise stand aside. The cost is that such clients keep the IdP's `iss`
  // instead of ours, which is a conformance gap; rejecting them outright would be
  // an outage, and an outage is worse.
  if (shouldIntercept && isCimdClientId(params.client_id) && deps.getRegisteredRedirectUris) {
    let resolved: string[]
    try {
      resolved = await deps.getRegisteredRedirectUris(params.client_id!)
    } catch {
      resolved = []
    }
    if (resolved.length === 0) {
      logger?.warn('CIMD metadata document unavailable — passing through to the IdP unintercepted', {
        clientId: params.client_id,
      })
      shouldIntercept = false
    }
  }

  // ── Validate redirect_uri against the client's registered URIs ────────
  // RFC 6749 §3.1.2.3 / §10.6: reject any redirect_uri that is not an EXACT
  // match for one registered to this client. Because the interceptor below
  // overwrites the redirect_uri sent to the IdP with the proxy callback, the
  // IdP can no longer validate the real client URI — so the proxy MUST do it
  // here (fail-closed) before storing it in the session.
  if (shouldIntercept && deps.getRegisteredRedirectUris) {
    const clientId = params.client_id || ''
    let registered: string[]
    try {
      registered = await deps.getRegisteredRedirectUris(clientId)
    } catch (err) {
      logger?.error('Failed to load registered redirect URIs — rejecting authorize', { clientId, err })
      return {
        result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'Unable to validate redirect_uri' },
      }
    }
    if (!isRedirectUriRegistered(params.redirect_uri!, registered)) {
      logger?.warn('Authorize rejected — redirect_uri not registered for client', {
        clientId,
        redirectUri: params.redirect_uri,
      })
      return {
        result: { type: 'error', status: 400, error: 'invalid_request', error_description: 'redirect_uri does not match a registered redirect URI for this client' },
      }
    }
  }

  // ── Create session for callback interception ──────────────────────────
  if (shouldIntercept) {
    const session: LaunchSession = {
      clientRedirectUri: params.redirect_uri!,
      clientState: params.state || '',
      clientId: params.client_id || '',
      scope: params.scope || '',
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method,
      aud: aud || undefined,
      needsPatientPicker: standaloneLaunch && !resolvedLaunchContext?.patient,
      // The launch KIND, kept because it outlives this request and the identity choice at callback
      // time reads it: an EHR launch means the human is here in a clinical capacity.
      ehrLaunch: !!resolvedLaunchContext,
      // Kept so an interstitial can honour `prompt=none` rather than interacting anyway.
      prompt: params.prompt,
      createdAt: Date.now(),
    }

    // Pre-populate context from EHR launch code
    if (resolvedLaunchContext) {
      if (resolvedLaunchContext.patient) session.patient = resolvedLaunchContext.patient
      if (resolvedLaunchContext.encounter) session.encounter = resolvedLaunchContext.encounter
      if (resolvedLaunchContext.fhirUser) session.fhirUser = resolvedLaunchContext.fhirUser
      if (resolvedLaunchContext.intent) session.intent = resolvedLaunchContext.intent
      if (resolvedLaunchContext.smartStyleUrl) session.smartStyleUrl = resolvedLaunchContext.smartStyleUrl
      if (resolvedLaunchContext.tenant) session.tenant = resolvedLaunchContext.tenant
      if (resolvedLaunchContext.needPatientBanner !== undefined) session.needPatientBanner = resolvedLaunchContext.needPatientBanner
      if (resolvedLaunchContext.fhirContext) session.fhirContext = resolvedLaunchContext.fhirContext
      if (resolvedLaunchContext.patient) session.needsPatientPicker = false
      if (resolvedLaunchContext.sub) session.launchSub = resolvedLaunchContext.sub
    }

    store.set(sessionKey, session)

    logger?.info('Authorization session created — intercepting callback', {
      sessionKey: sessionKey.slice(0, 8) + '...',
      clientId: session.clientId,
      reason: smartLaunch ? 'smart-launch' : 'proxy-issued-resource',
      needsPatientPicker: session.needsPatientPicker,
      hasLaunchCode: !!resolvedLaunchContext,
    })
  }

  // ── Forward all query params to IdP ───────────────────────────────────
  // Strip aud/resource from the generic copy; RFC 8707 uses `resource` (not
  // `aud`). We forward the validated audience as `resource` below.
  const stripFromIdp = new Set(['aud', 'resource'])
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && !stripFromIdp.has(k)) {
      url.searchParams.set(k, v)
    }
  }

  // ── RFC 8707 resource indicator ───────────────────────────────────────
  // Keycloak 26.6.3 supports RFC 8707 via the resource-indicators feature
  // (a TokenPostProcessor). We forward the validated requested audience as the
  // `resource` parameter so Keycloak binds it into the access-token aud. The
  // post-processor's ResourceIndicatorValidation rejects a value with a query
  // or fragment, so only forward clean absolute URIs (the FHIR base and MCP
  // URL have neither).
  if (aud && !aud.includes('?') && !aud.includes('#')) {
    url.searchParams.set('resource', aud)
  }

  // ── Rewrite redirect_uri and state for interception ───────────────────
  if (shouldIntercept) {
    const callbackUrl = `${config.baseUrl}${callbackPath}`
    url.searchParams.set('redirect_uri', callbackUrl)
    url.searchParams.set('state', sessionKey)
  }

  // ── Pass launch context as additional IdP params ──────────────────────
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
