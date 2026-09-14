// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The token endpoint and the device-grant entry point.
 *
 * The proxy IS the token endpoint SMART clients are told about, so it does
 * three things Keycloak cannot: it validates and re-signs private_key_jwt
 * assertions, it re-sends the resource captured at /authorize, and it adds the
 * SMART launch context to the response.
 */

import { Elysia } from 'elysia'
import fetch from 'cross-fetch'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { validateToken } from '@/lib/auth'
import { getAllServers } from '@/lib/fhir-server-store'
import { getSmartClientConfig } from '@/lib/smart-client-config-cache'
import { resolveFhirUserForClient } from '@/lib/consent/person-resolver'
import { recordLastLogin } from '@/lib/last-login'
import { tokenContextStore } from '@/lib/token-context-store'
import { hasClientAssertion, translateClientAssertion, ClientAssertionError } from '../backend-services'
import { smartProxyConfig, smartStore, keycloakAdapter, smartLogger } from '../smart-proxy-setup'
import {
  enrichTokenResponse,
  getRewrittenRedirectUri,
  getSessionAudience,
  toAbsoluteFhirUser,
  canReturnPatient,
  parseScopes,
  type TokenPayload,
} from '@proxy-smart/auth'
import {
  TokenRequest,
  TokenResponse,
  DeviceAuthorizationRequest,
  DeviceAuthorizationResponse,
} from '@/schemas'
import { generateAuthorizationDetailsFromToken, logTokenEvent, parseFormBody } from './shared'

type TokenRequestBody = Record<string, string | undefined>
type TokenResponseBody = Record<string, unknown>

/** Fields forwarded to Keycloak verbatim, with the camelCase alias clients also send. */
const FORWARDED_FIELDS: Array<[string, string?]> = [
  ['grant_type', 'grantType'],
  ['code'],
  ['client_id', 'clientId'],
  ['client_secret', 'clientSecret'],
  ['code_verifier', 'codeVerifier'],
  // RFC 8628 device-grant poll: without device_code Keycloak cannot match the
  // pending authorization and the device login never completes.
  ['device_code', 'deviceCode'],
  ['refresh_token', 'refreshToken'],
  ['scope'],
  ['audience'],
  ['username'],
  ['password'],
  ['client_assertion_type'],
  ['client_assertion'],
  ['subject_token'],
  ['subject_token_type'],
  ['requested_token_type'],
]

function buildKeycloakForm(
  body: TokenRequestBody,
  extras: { redirectUri?: string; resource?: string },
): URLSearchParams {
  const form = new URLSearchParams()

  for (const [field, alias] of FORWARDED_FIELDS) {
    const value = body[field] ?? (alias ? body[alias] : undefined)
    if (value) form.append(field, value)
  }

  if (extras.redirectUri) form.append('redirect_uri', extras.redirectUri)
  // Keycloak's ResourceIndicatorValidation rejects a resource carrying a query
  // or fragment, so an unusable value is dropped rather than sent.
  if (extras.resource && !extras.resource.includes('?') && !extras.resource.includes('#')) {
    form.append('resource', extras.resource)
  }

  return form
}

/**
 * Add the SMART launch context to a successful token response.
 *
 * Never throws: enrichment failing must not turn an issued token into an error,
 * so the caller keeps Keycloak's response as it stands.
 */
async function applyLaunchContext(
  data: TokenResponseBody,
  input: { accessToken: string; clientId?: string; redirectUri?: string; requestedScope?: string; grantType?: string },
): Promise<void> {
  const { accessToken, clientId, redirectUri, requestedScope, grantType } = input

  const tokenPayload = await validateToken(accessToken)

  // Not awaited: the sign-in is already granted, and stamping it must not delay the response.
  if (grantType === 'authorization_code' && typeof tokenPayload.sub === 'string') {
    void recordLastLogin(tokenPayload.sub)
  }

  const enrichment = enrichTokenResponse(
    {
      tokenPayload: tokenPayload as TokenPayload,
      clientId,
      redirectUri,
      grantedScope: typeof data.scope === 'string' ? data.scope : undefined,
    },
    { config: smartProxyConfig, store: smartStore, logger: smartLogger },
  )

  if (enrichment.patient) data.patient = enrichment.patient
  if (enrichment.encounter) data.encounter = enrichment.encounter
  if (enrichment.intent) data.intent = enrichment.intent
  if (enrichment.smart_style_url) data.smart_style_url = enrichment.smart_style_url
  if (enrichment.tenant) data.tenant = enrichment.tenant
  if (enrichment.need_patient_banner !== undefined) data.need_patient_banner = enrichment.need_patient_banner
  if (enrichment.fhirContext) data.fhirContext = enrichment.fhirContext
  if (enrichment.scope) data.scope = enrichment.scope

  const grantedScope = typeof data.scope === 'string' ? data.scope : requestedScope ?? ''

  // ── Backend-specific: per-client fhirUser resolution ────────
  if (!data.fhirUser && tokenPayload.fhirUser && grantedScope.includes('openid')) {
    const clientConfig = await getSmartClientConfig(clientId || '')
    const serverInfos = await getAllServers()
    const firstServer = serverInfos.length > 0 ? serverInfos[0] : null
    const fhirBaseUrl = firstServer
      ? `${config.baseUrl}/${config.name}/${firstServer.identifier}/${firstServer.metadata.fhirVersion}`
      : ''

    /*
     * Read the Person UPSTREAM, not back through the proxy with the app's own token.
     *
     * Going through fhirBaseUrl re-enters access control, and a patient-scoped grant is
     * refused there when the token carries no patient context yet — which is exactly the
     * state this call exists to resolve. The app cannot read the Person that would
     * establish its context because it has no context, so a Person fhirUser silently
     * produced no fhirUser and no patient for every patient-facing app.
     *
     * The proxy is the one asking, and it only ever follows a link the Person named in
     * the token's own claim declares, so it resolves against the server directly. The
     * reference is still handed back re-based on fhirBaseUrl below: what the app sees
     * does not change, only who performs the lookup.
     */
    const resolvedFhirUser = await resolveFhirUserForClient(
      tokenPayload.fhirUser, clientConfig.patientFacing, firstServer?.url || fhirBaseUrl,
      firstServer?.identifier || '', `Bearer ${accessToken}`
    )
    if (resolvedFhirUser) {
      data.fhirUser = toAbsoluteFhirUser(resolvedFhirUser, fhirBaseUrl)
    }
  }

  // Derive patient from resolved fhirUser if not already set. Uses the shared
  // canReturnPatient rule so this agrees with the token and introspection
  // enrichers — including patient/ scopes, which carry the same context
  // obligation as launch/patient (SMART 2.2: the EHR SHALL establish a patient
  // in context when granting them).
  if (!data.patient && typeof data.fhirUser === 'string' && canReturnPatient(parseScopes(grantedScope))) {
    const patientMatch = data.fhirUser.match(/Patient\/([^/]+)$/)
    if (patientMatch) data.patient = patientMatch[1]
  }

  const generatedDetails = await generateAuthorizationDetailsFromToken(tokenPayload as TokenPayload)
  if (generatedDetails) data.authorization_details = generatedDetails

  // ── Persist launch context for introspection (SMART STU 2.2 §5.2) ──
  // The spec requires introspection to return the same launch context that was
  // in the original token response. Stored by JTI for lookup.
  const claims = tokenPayload as Record<string, unknown>
  const jti = typeof claims.jti === 'string' ? claims.jti : undefined
  if (jti && (data.patient || data.encounter || data.fhirUser)) {
    tokenContextStore.set(jti, {
      patient: typeof data.patient === 'string' ? data.patient : undefined,
      encounter: typeof data.encounter === 'string' ? data.encounter : undefined,
      fhirUser: typeof data.fhirUser === 'string' ? data.fhirUser : undefined,
      intent: typeof data.intent === 'string' ? data.intent : undefined,
      smart_style_url: typeof data.smart_style_url === 'string' ? data.smart_style_url : undefined,
      tenant: typeof data.tenant === 'string' ? data.tenant : undefined,
      need_patient_banner: typeof data.need_patient_banner === 'boolean' ? data.need_patient_banner : undefined,
      clientId,
      exp: typeof claims.exp === 'number' ? claims.exp : undefined,
    })
  }
}

export const tokenRoutes = new Elysia({ tags: ['authentication'] })

  // ── Token endpoint ────────────────────────────────────────────────────
  .post('/token', async ({ body, set, headers }) => {
    const startTime = Date.now()
    const kcUrl = keycloakAdapter.getTokenUrl()
    const bodyObj = body as TokenRequestBody

    logger.auth.debug('Token endpoint request', {
      grant_type: bodyObj.grant_type || bodyObj.grantType || 'MISSING',
      client_id: bodyObj.client_id || bodyObj.clientId || 'MISSING',
      has_code: !!bodyObj.code,
    })

    try {
      // ── Intercept private_key_jwt assertions (all grant types) ──────
      // Validate the client's assertion, then re-sign with the proxy's key for
      // Keycloak's federated client authentication. This lets clients use
      // aud=proxy_url without knowing Keycloak's internal URL.
      if (hasClientAssertion(bodyObj)) {
        try {
          const { clientId, proxyAssertion } = await translateClientAssertion(
            bodyObj.client_assertion!, bodyObj.client_id
          )
          bodyObj.client_assertion = proxyAssertion
          if (!bodyObj.client_id) bodyObj.client_id = clientId
        } catch (err) {
          if (err instanceof ClientAssertionError) {
            set.status = err.httpStatus
            set.headers['Cache-Control'] = 'no-store'
            set.headers['Pragma'] = 'no-cache'
            return { error: err.oauthError, error_description: err.description }
          }
          throw err
        }
      }

      const clientRedirectUri = bodyObj.redirect_uri || bodyObj.redirectUri
      const clientIdForSession = bodyObj.client_id || bodyObj.clientId
      const smartDeps = { config: smartProxyConfig, store: smartStore, logger: smartLogger }

      // Redirect URI rewrite for SMART sessions (delegates to lib)
      const rewrittenUri = getRewrittenRedirectUri(clientIdForSession, clientRedirectUri, smartDeps)

      // RFC 8707: re-send the resource captured at /authorize so it matches what
      // Keycloak stored on the code — a mismatch answers ERROR_NOT_MATCHING. The
      // session value wins over any client-sent resource.
      const sessionAud = getSessionAudience(clientIdForSession, clientRedirectUri, smartDeps)

      const formData = buildKeycloakForm(bodyObj, {
        redirectUri: rewrittenUri || clientRedirectUri,
        resource: sessionAud ?? bodyObj.resource,
      })

      const resp = await fetch(kcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      })

      const data: TokenResponseBody = await resp.json()
      const requestedScope = bodyObj.scope

      await logTokenEvent({
        path: '/auth/token',
        clientId: clientIdForSession || 'unknown',
        grantType: bodyObj.grant_type || bodyObj.grantType || 'unknown',
        scope: requestedScope,
        status: resp.status,
        responseTime: Date.now() - startTime,
        headers,
        data,
      })

      set.status = resp.status
      set.headers['Cache-Control'] = 'no-store'
      set.headers['Pragma'] = 'no-cache'

      if (data.error) return data

      if (typeof data.access_token === 'string' && resp.status === 200) {
        try {
          await applyLaunchContext(data, {
            accessToken: data.access_token,
            clientId: clientIdForSession,
            redirectUri: clientRedirectUri,
            requestedScope,
            grantType: bodyObj.grant_type || bodyObj.grantType,
          })
        } catch (contextError) {
          logger.auth.warn('Failed to add launch context to token response', { contextError })
        }
      }

      return data
    } catch (error) {
      logger.auth.error('Token endpoint error', { error })
      set.status = 500
      return { error: 'internal_server_error', error_description: 'Failed to process token request' }
    }
  }, {
    parse: parseFormBody,
    body: TokenRequest,
    response: { 200: TokenResponse },
    detail: { summary: 'OAuth Token Exchange', description: 'Exchange authorization code for access token with SMART launch context', tags: ['authentication'] }
  })

  // ── Device authorization endpoint (RFC 8628) ──────────────────────────
  // Fronts Keycloak's device-authorization endpoint so CLI / device clients
  // begin the device grant at the proxy instead of talking to Keycloak
  // directly. The form body is forwarded verbatim and Keycloak's JSON response
  // returned as-is, verification_uri included — that approval page is the IdP's.
  // The device_code poll then happens at /auth/token above.
  .post('/device', async ({ body, set, headers }) => {
    const startTime = Date.now()
    const deviceUrl = keycloakAdapter.getDeviceAuthorizationUrl?.()
    const bodyObj = body as TokenRequestBody

    if (!deviceUrl) {
      set.status = 501
      set.headers['Cache-Control'] = 'no-store'
      return { error: 'unsupported', error_description: 'Device authorization is not supported by this authorization server' }
    }

    logger.auth.debug('Device authorization request', {
      client_id: bodyObj.client_id || 'MISSING',
      has_scope: !!bodyObj.scope,
    })

    try {
      // The device grant has no SMART session yet (no redirect_uri, no code), so
      // there is no resource to inject here — that binding happens, if at all,
      // when the token is later minted at /auth/token.
      const formData = new URLSearchParams()
      for (const [key, value] of Object.entries(bodyObj)) {
        if (value !== undefined && value !== '') formData.append(key, value)
      }

      const resp = await fetch(deviceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      })

      const data: TokenResponseBody = await resp.json()

      await logTokenEvent({
        path: '/auth/device',
        clientId: bodyObj.client_id || 'unknown',
        grantType: 'device_authorization',
        scope: bodyObj.scope,
        status: resp.status,
        responseTime: Date.now() - startTime,
        headers,
        data,
      })

      set.status = resp.status
      set.headers['Cache-Control'] = 'no-store'
      set.headers['Pragma'] = 'no-cache'
      return data
    } catch (error) {
      logger.auth.error('Device authorization endpoint error', { error })
      set.status = 500
      return { error: 'internal_server_error', error_description: 'Failed to process device authorization request' }
    }
  }, {
    parse: parseFormBody,
    body: DeviceAuthorizationRequest,
    response: { 200: DeviceAuthorizationResponse },
    detail: { summary: 'OAuth Device Authorization (RFC 8628)', description: 'Begin the device authorization grant through the proxy. Forwards to the authorization server device endpoint and returns the device_code / user_code response.', tags: ['authentication'] }
  })
