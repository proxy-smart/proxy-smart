// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The launch path: an EHR mints a launch code, the app is authorized, Keycloak
 * calls back. The protocol decisions live in @proxy-smart/auth; these handlers
 * supply the deployment's dependencies and render its error pages.
 */

import { Elysia } from 'elysia'
import { config } from '@/config'
import { getRegisteredRedirectUris } from '@/lib/smart-client-config-cache'
import { autoResolvePatient } from '@/lib/kc-session-resolver'
import { jtiReplayCache } from '@/lib/cache/jti-replay-cache'
import { smartProxyConfig, smartStore, keycloakAdapter, smartLogger } from '../smart-proxy-setup'
import { kcUnavailablePage, authErrorPage } from '@/web/status-pages'
import { handleAuthorize, handleCallback, type AuthorizeParams } from '@proxy-smart/auth'
import { AuthorizationQuery, SmartCallbackQuery, EhrLaunchRequest } from '@/schemas'
import { isKeycloakReachable, parseFormBody, resolveIdentities, validateAudience } from './shared'
import { authenticateLaunchCaller, mintLaunchCode } from './launch-mint'
import { launchStepDeps } from './picker-support'

/** Launch codes share the assertion jti store, under their own issuer so the two never collide. */
const LAUNCH_CODE_ISSUER = 'urn:proxy-smart:launch-code'
const claimLaunchCode = (jti: string, expiresAt: number) => jtiReplayCache.spend(LAUNCH_CODE_ISSUER, jti, expiresAt)

/**
 * The authorization endpoint, for GET and for SMART's authorize-post. A POST is answered with 303
 * so the browser follows the redirect with a GET.
 */
async function authorize(params: AuthorizeParams, redirectStatus: 302 | 303): Promise<Response> {
  const { result } = await handleAuthorize(params, {
    config: smartProxyConfig,
    store: smartStore,
    idp: keycloakAdapter,
    logger: smartLogger,
    validateAudience,
    isIdpReachable: isKeycloakReachable,
    getRegisteredRedirectUris,
    claimLaunchCode,
  })

  switch (result.type) {
    case 'redirect':
      return new Response(null, { status: redirectStatus, headers: { Location: result.url } })
    case 'error':
      if (result.status === 503) return kcUnavailablePage()
      return Response.json({ error: result.error, error_description: result.error_description }, { status: result.status })
    case 'response':
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
  .get('/authorize', ({ query }) => authorize(query, 302), {
    query: AuthorizationQuery,
    detail: { summary: 'OAuth Authorization Endpoint', description: AUTHORIZE_DESCRIPTION, tags: ['authentication'] }
  })

  .post('/authorize', ({ body }) => authorize(body, 303), {
    parse: parseFormBody,
    body: AuthorizationQuery,
    detail: { summary: 'OAuth Authorization Endpoint (POST)', description: `${AUTHORIZE_DESCRIPTION}. Accepts the GET parameters as an application/x-www-form-urlencoded body (SMART authorize-post).`, tags: ['authentication'] }
  })

  // ── SMART callback (delegates to @proxy-smart/auth) ───────────────────
  .get('/smart-callback', async ({ query, redirect, set }) => {
    const { result, session } = await handleCallback(
      { state: query.state, code: query.code, error: query.error, error_description: query.error_description, session_state: query.session_state },
      { ...launchStepDeps, autoResolvePatient, getRegisteredRedirectUris, resolveIdentities },
    )

    switch (result.type) {
      case 'redirect':
        return redirect(result.url)
      case 'error':
        // Only when no client redirect can be trusted: refusals with one go back to the client.
        return authErrorPage({
          status: result.status,
          error: result.error,
          errorDescription: result.error_description,
          signedInAs: session?.fhirUser,
          logoutUrl: query.state
            ? `${config.baseUrl}/auth/logout?state=${encodeURIComponent(query.state)}`
            : `${config.baseUrl}/auth/logout`,
        })
      case 'response':
        set.status = result.status
        return result.body
    }
  }, {
    query: SmartCallbackQuery,
    detail: { summary: 'SMART Launch Callback', description: 'Receives Keycloak callback during SMART launch flows.', tags: ['authentication'] }
  })
