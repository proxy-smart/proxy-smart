// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The launch path: an EHR mints a launch code, the app is authorized, Keycloak
 * calls back. The protocol decisions live in @proxy-smart/auth; these handlers
 * supply the deployment's dependencies and render its error pages.
 */

import { Elysia } from 'elysia'
import { config } from '@/config'
import { validateToken } from '@/lib/auth'
import { getRegisteredRedirectUris } from '@/lib/smart-client-config-cache'
import { autoResolvePatient } from '@/lib/kc-session-resolver'
import { smartProxyConfig, smartStore, keycloakAdapter, smartLogger } from '../smart-proxy-setup'
import { kcUnavailablePage, authErrorPage } from '@/web/status-pages'
import {
  handleAuthorize,
  handleCallback,
  signLaunchCode,
  toLaunchCodeOptions,
  type AuthorizeParams,
  type LaunchCodePayload,
} from '@proxy-smart/auth'
import { AuthorizationQuery, SmartCallbackQuery, EhrLaunchRequest } from '@/schemas'
import { isKeycloakReachable, resolveIdentities, validateAudience } from './shared'

export const launchRoutes = new Elysia({ tags: ['authentication'] })

  // ── EHR Launch: issue a signed launch code ────────────────────────────
  .post('/launch', async ({ body, set, headers }) => {
    const authHeader = headers.authorization || headers.Authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      set.status = 401
      return { error: 'unauthorized', error_description: 'Bearer token required to issue launch codes' }
    }
    try {
      await validateToken(authHeader.slice(7))
    } catch {
      set.status = 401
      return { error: 'unauthorized', error_description: 'Invalid or expired Bearer token' }
    }

    if (!body.patient && !body.encounter && !body.fhirUser && !body.intent && !body.fhirContext) {
      set.status = 400
      return { error: 'invalid_request', error_description: 'At least one launch context parameter is required (patient, encounter, fhirUser, intent, or fhirContext)' }
    }

    const launchPayload: LaunchCodePayload = {
      ...(body.patient && { patient: body.patient }),
      ...(body.encounter && { encounter: body.encounter }),
      ...(body.fhirUser && { fhirUser: body.fhirUser }),
      ...(body.intent && { intent: body.intent }),
      ...(body.smartStyleUrl && { smartStyleUrl: body.smartStyleUrl }),
      ...(body.tenant && { tenant: body.tenant }),
      ...(body.needPatientBanner !== undefined && { needPatientBanner: body.needPatientBanner }),
      ...(body.fhirContext && { fhirContext: JSON.stringify(body.fhirContext) }),
      ...(body.clientId && { clientId: body.clientId }),
    }

    const launch = signLaunchCode(launchPayload, toLaunchCodeOptions(smartProxyConfig, smartLogger))

    return { launch, expires_in: config.smart.launchCodeTtlSeconds }
  }, {
    body: EhrLaunchRequest,
    detail: { summary: 'EHR Launch: Issue Launch Code', description: 'Issues a signed, time-limited launch code that encodes EHR session context.', tags: ['authentication'] }
  })

  // ── Authorization endpoint (delegates to @proxy-smart/auth) ───────────
  .get('/authorize', async ({ query, redirect, set }) => {
    const { result } = await handleAuthorize(query as unknown as AuthorizeParams, {
      config: smartProxyConfig,
      store: smartStore,
      idp: keycloakAdapter,
      logger: smartLogger,
      validateAudience,
      isIdpReachable: isKeycloakReachable,
      getRegisteredRedirectUris,
    })

    switch (result.type) {
      case 'redirect':
        return redirect(result.url)
      case 'error':
        if (result.status === 503) return kcUnavailablePage()
        set.status = result.status
        return { error: result.error, error_description: result.error_description }
      case 'response':
        set.status = result.status
        return result.body
    }
  }, {
    query: AuthorizationQuery,
    detail: { summary: 'OAuth Authorization Endpoint', description: 'Redirects to Keycloak authorization endpoint for OAuth flow with SMART launch support', tags: ['authentication'] }
  })

  // ── SMART callback (delegates to @proxy-smart/auth) ───────────────────
  .get('/smart-callback', async ({ query, redirect, set }) => {
    const { result, session } = await handleCallback(
      { state: query.state, code: query.code, error: query.error, error_description: query.error_description, session_state: query.session_state },
      { config: smartProxyConfig, store: smartStore, logger: smartLogger, autoResolvePatient, getRegisteredRedirectUris, resolveIdentities },
    )

    switch (result.type) {
      case 'redirect':
        return redirect(result.url)
      case 'error': {
        /*
         * An account with no identity at all is an unfinished sign-up, so the page says that
         * and points at where to finish it, keeping the clinician case in the hint: two
         * different people land here, and "requires a practitioner account" speaks to one of
         * them while being flatly wrong for the other. Where onboarding lives is deployment
         * config — a deployment that sets nothing still gets the explanation.
         */
        const notLinked = result.reason === 'account-not-linked'
        return authErrorPage({
          status: result.status,
          error: result.error,
          errorDescription: result.error_description,
          signedInAs: session?.fhirUser,
          logoutUrl: query.state
            ? `${config.baseUrl}/auth/logout?state=${encodeURIComponent(query.state)}`
            : `${config.baseUrl}/auth/logout`,
          ...(notLinked
            ? {
                variant: 'setup' as const,
                hint: 'Signing in as a clinician through your organization? Your administrator links your account to your Practitioner record instead.',
                ...(config.patientOnboardingUrl
                  ? { retryUrl: config.patientOnboardingUrl, retryLabel: 'Set up my record' }
                  : {}),
              }
            : {}),
        })
      }
      case 'response':
        set.status = result.status
        return result.body
    }
  }, {
    query: SmartCallbackQuery,
    detail: { summary: 'SMART Launch Callback', description: 'Receives Keycloak callback during SMART launch flows.', tags: ['authentication'] }
  })
