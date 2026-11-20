// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The launch path: an EHR mints a launch code, the app is authorized, Keycloak
 * calls back. The protocol decisions live in @proxy-smart/auth; these handlers
 * supply the deployment's dependencies and render its error pages.
 */

import { Elysia } from 'elysia'
import { config } from '@/config'
import { getPreferredIdentityProvider, getRegisteredRedirectUris, getRequiredAcr } from '@/lib/smart-client-config-cache'
import { autoResolvePatient } from '@/lib/kc-session-resolver'
import { jtiReplayCache } from '@/lib/cache/jti-replay-cache'
import { smartProxyConfig, smartStore, keycloakAdapter, smartLogger } from '../smart-proxy-setup'
import { kcUnavailablePage, authErrorPage } from '@/web/status-pages'
import { handleAuthorize, handleCallback, type AuthorizeParams } from '@proxy-smart/auth'
import { AuthorizationQuery, SmartCallbackQuery, EhrLaunchRequest } from '@/schemas'
import { admitUser, isKeycloakReachable, logOAuthEvent, parseFormBody, resolveIdentities, validateAudience } from './shared'
import { authenticateLaunchCaller, mintLaunchCode } from './launch-mint'
import { launchStepDeps } from './picker-support'
import { standInForCimdClient } from '../cimd-client'
import { consentGate } from './consent'
import { logger } from '@/lib/logger'
import { clientIp, type ClientIpOptions } from '@/lib/client-ip'

/** Launch codes share the assertion jti store, under their own issuer so the two never collide. */
const LAUNCH_CODE_ISSUER = 'urn:proxy-smart:launch-code'
const claimLaunchCode = (jti: string, expiresAt: number) => jtiReplayCache.spend(LAUNCH_CODE_ISSUER, jti, expiresAt)

interface FlowRequest {
  started: number
  headers: Record<string, string | undefined>
  ipAddress?: string
}

const flowRequest = (request: Request, server: ClientIpOptions['server'], headers: Record<string, string | undefined>): FlowRequest =>
  ({ started: Date.now(), headers, ipAddress: clientIp(request, { server }) })

function logAuthorizationStep(
  flow: FlowRequest,
  step: { path: string; method: 'GET' | 'POST'; clientId?: string; scope?: string; status: number; error?: string; errorDescription?: string },
): Promise<void> {
  return logOAuthEvent({
    type: 'authorization',
    path: step.path,
    method: step.method,
    clientId: step.clientId || 'unknown',
    grantType: 'authorization_code',
    scope: step.scope,
    status: step.status,
    responseTime: Date.now() - flow.started,
    headers: flow.headers,
    ipAddress: flow.ipAddress,
    data: { error: step.error, error_description: step.errorDescription },
  })
}

/**
 * The authorization endpoint, for GET and for SMART's authorize-post. A POST is answered with 303
 * so the browser follows the redirect with a GET.
 */
async function authorize(params: AuthorizeParams, redirectStatus: 302 | 303, flow: FlowRequest): Promise<Response> {
  const { result } = await handleAuthorize(params, {
    config: smartProxyConfig,
    store: smartStore,
    idp: keycloakAdapter,
    logger: smartLogger,
    validateAudience,
    isIdpReachable: isKeycloakReachable,
    getRegisteredRedirectUris,
    claimLaunchCode,
    preferredIdentityProvider: getPreferredIdentityProvider,
    requiredAcr: getRequiredAcr,
    standInForCimdClient,
  })

  const step = { path: '/auth/authorize', method: redirectStatus === 303 ? 'POST' as const : 'GET' as const, clientId: params.client_id, scope: params.scope }
  switch (result.type) {
    case 'redirect': {
      const target = new URL(result.url).searchParams
      await logAuthorizationStep(flow, { ...step, status: redirectStatus, error: target.get('error') ?? undefined, errorDescription: target.get('error_description') ?? undefined })
      return new Response(null, { status: redirectStatus, headers: { Location: result.url } })
    }
    case 'error':
      logger.auth.warn('Authorization refused', { clientId: params.client_id, status: result.status, error: result.error })
      await logAuthorizationStep(flow, { ...step, status: result.status, error: result.error, errorDescription: result.error_description })
      if (result.status === 503) return kcUnavailablePage()
      return Response.json({ error: result.error, error_description: result.error_description }, { status: result.status })
    case 'response':
      await logAuthorizationStep(flow, { ...step, status: result.status })
      return Response.json(result.body, { status: result.status, headers: result.headers })
  }
}

const AUTHORIZE_DESCRIPTION = 'Redirects to the Keycloak authorization endpoint for the OAuth flow with SMART launch support'

export const launchRoutes = new Elysia({ tags: ['authentication'] })

  // ── EHR Launch: issue a signed launch code ────────────────────────────
  .post('/launch', async ({ body, set, headers }) => {
    const authenticated = await authenticateLaunchCaller(headers.authorization || headers.Authorization)
    if (!authenticated.ok) {
      set.status = 401
      return { error: authenticated.error, error_description: authenticated.error_description }
    }

    if (!body.patient && !body.encounter && !body.fhirUser && !body.intent && !body.fhirContext && body.appContext === undefined) {
      set.status = 400
      return { error: 'invalid_request', error_description: 'At least one launch context parameter is required (patient, encounter, fhirUser, intent, fhirContext, or appContext)' }
    }

    const { clientId, iss, ...context } = body
    if (!clientId) {
      set.status = 400
      return { error: 'invalid_request', error_description: 'clientId is required: a launch code is bound to the client it launches' }
    }

    const minted = await mintLaunchCode(authenticated.caller, authenticated.authHeader, { ...context, clientId, ...(iss && { fhirBase: iss }) })
    if (!minted.ok) {
      set.status = minted.status
      return { error: minted.error, error_description: minted.error_description }
    }
    return { launch: minted.launch, expires_in: minted.expiresIn }
  }, {
    body: EhrLaunchRequest,
    detail: { summary: 'EHR Launch: Issue Launch Code', description: 'Issues a signed, time-limited launch code that encodes EHR session context.', tags: ['authentication'] }
  })

  // ── Authorization endpoint (delegates to @proxy-smart/auth) ───────────
  .get('/authorize', ({ query, request, server, headers }) => authorize(query, 302, flowRequest(request, server, headers)), {
    query: AuthorizationQuery,
    detail: { summary: 'OAuth Authorization Endpoint', description: AUTHORIZE_DESCRIPTION, tags: ['authentication'] }
  })

  .post('/authorize', ({ body, request, server, headers }) => authorize(body, 303, flowRequest(request, server, headers)), {
    parse: parseFormBody,
    body: AuthorizationQuery,
    detail: { summary: 'OAuth Authorization Endpoint (POST)', description: `${AUTHORIZE_DESCRIPTION}. Accepts the GET parameters as an application/x-www-form-urlencoded body (SMART authorize-post).`, tags: ['authentication'] }
  })

  // ── SMART callback (delegates to @proxy-smart/auth) ───────────────────
  .get('/smart-callback', async ({ query, redirect, set, request, server, headers }) => {
    const flow = flowRequest(request, server, headers)
    const { result, session } = await handleCallback(
      { state: query.state, code: query.code, error: query.error, error_description: query.error_description, session_state: query.session_state },
      { ...(await launchStepDeps()), admitUser, autoResolvePatient, getRegisteredRedirectUris, resolveIdentities, consentPending: consentGate.consentPending },
    )

    const clientId = session?.clientId
    const step = { path: '/auth/smart-callback', method: 'GET' as const, clientId, scope: session?.scope }
    switch (result.type) {
      case 'redirect':
        await logAuthorizationStep(flow, { ...step, status: 302, error: query.error, errorDescription: query.error_description })
        return redirect(result.url)
      case 'error':
        logger.auth.warn('Sign-in callback failed', { clientId, status: result.status, error: result.error, description: result.error_description })
        await logAuthorizationStep(flow, { ...step, status: result.status, error: result.error, errorDescription: result.error_description })
        // Only when no client redirect can be trusted: refusals with one go back to the client.
        return authErrorPage({
          status: result.status,
          error: result.error,
          errorDescription: result.error_description,
          signedInAs: session?.fhirUser,
          returnUrl: clientId
            ? `${config.baseUrl}/auth/return?client_id=${encodeURIComponent(clientId)}`
            : `${config.baseUrl}/auth/return`,
          logoutUrl: query.state
            ? `${config.baseUrl}/auth/logout?state=${encodeURIComponent(query.state)}`
            : `${config.baseUrl}/auth/logout`,
        })
      case 'response':
        await logAuthorizationStep(flow, { ...step, status: result.status })
        set.status = result.status
        return result.body
    }
  }, {
    query: SmartCallbackQuery,
    detail: { summary: 'SMART Launch Callback', description: 'Receives Keycloak callback during SMART launch flows.', tags: ['authentication'] }
  })
