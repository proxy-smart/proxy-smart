// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The token endpoint and the device-grant entry point.
 *
 * The proxy IS the token endpoint SMART clients are told about, so it does
 * what Keycloak cannot: it validates and re-signs private_key_jwt assertions,
 * compares the app's redirect_uri for codes it intercepted, re-sends the
 * resource captured at /authorize, and adds the SMART launch context to the
 * response, refreshes included.
 */

import { Elysia } from 'elysia'
import { logger } from '@/lib/logger'
import { tokenContextStore } from '@/lib/token-context-store'
import { resolveTokenPatientId } from '@/lib/patient-context'
import { TOKEN_EXCHANGE_GRANT, actorChain, delegationActor } from '@/lib/token-actor'
import { resourceAudienceResolver } from '@/lib/resource-audience'
import { FHIR_RESOURCE_CLIENT_ID } from '@/lib/token-audience'
import { noStore, oauthError } from '@/lib/oauth-errors'
import { hasClientAssertion, translateClientAssertion, ClientAssertionError } from '../backend-services'
import { signProxyAssertion } from '@/lib/proxy-signing'
import { smartProxyConfig, smartStore, keycloakAdapter, smartLogger } from '../smart-proxy-setup'
import {
  getRewrittenRedirectUri,
  getSessionAudience,
  hasPatientCompartmentScope,
  parseScopes,
  verifyCodeRedemption,
} from '@proxy-smart/auth'
import {
  TokenRequest,
  TokenResponse,
  DeviceAuthorizationRequest,
  DeviceAuthorizationResponse,
} from '@/schemas'
import { clientBasicAuth } from '@/lib/http-auth'
import { authEndpointRateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'
import { optionalString, requireRecord } from '@/lib/type-guards'
import { logTokenEvent, parseFormBody } from './shared'
import {
  applyLaunchContext,
  carriedRefreshContext,
  readGrantedToken,
  type ExchangeContext,
  type TokenResponseBody,
} from './token-launch-context'

type TokenRequestBody = Record<string, string | undefined>

/**
 * Who a token-exchange grant acted for. Runs only after Keycloak issued the token,
 * so both tokens are ours; the patient carries over only when the subject stays the same person.
 */
async function resolveExchange(subjectToken: string, issuedToken: string): Promise<ExchangeContext | null> {
  try {
    const [subject, issued] = await Promise.all([readGrantedToken(subjectToken), readGrantedToken(issuedToken)])
    const issuedClient = optionalString(issued.azp)
    if (!issuedClient) return null
    const subjectJti = optionalString(subject.jti)
    const subjectAct = subjectJti ? (await tokenContextStore.get(subjectJti))?.act : undefined
    const act = delegationActor(issuedClient, subject, subjectAct)
    if (!act) return null
    const samePerson = typeof subject.sub === 'string' && subject.sub === issued.sub
    const patient = samePerson ? (await resolveTokenPatientId(subject)) ?? undefined : undefined
    return { act, ...(patient && { patient }) }
  } catch (error) {
    logger.auth.warn('Token exchange issued, but its actor could not be resolved', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * SMART Backend Services names no resource, and this token endpoint is the FHIR server's, so the token is
 * bound there. Null: the requested resource has no resource client. Unreadable clients leave it to Keycloak.
 */
async function clientCredentialsResource(requested: string | undefined): Promise<string | undefined | null> {
  try {
    if (!requested) return (await resourceAudienceResolver.resourceOf(FHIR_RESOURCE_CLIENT_ID)) ?? undefined
    return (await resourceAudienceResolver.audienceFor(requested)) ? requested : null
  } catch (error) {
    logger.auth.warn('Resource clients unreadable, forwarding client_credentials unbound', {
      error: error instanceof Error ? error.message : String(error),
    })
    return requested
  }
}

/** Fields forwarded to Keycloak verbatim. */
const FORWARDED_FIELDS = [
  'grant_type',
  'code',
  'client_id',
  'client_secret',
  'code_verifier',
  // RFC 8628 device-grant poll: without device_code Keycloak cannot match the pending authorization.
  'device_code',
  'refresh_token',
  'scope',
  'audience',
  'username',
  'password',
  'client_assertion_type',
  'client_assertion',
  'subject_token',
  'subject_token_type',
  'requested_token_type',
] as const

function buildKeycloakForm(
  body: TokenRequestBody,
  extras: { redirectUri?: string; resource?: string },
): URLSearchParams {
  const form = new URLSearchParams()

  for (const field of FORWARDED_FIELDS) {
    const value = body[field]
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

export const tokenRoutes = new Elysia({ tags: ['authentication'] })

  // ── Token endpoint ────────────────────────────────────────────────────
  .post('/token', async ({ body, set, headers, request, server }) => {
    const startTime = Date.now()
    const kcUrl = keycloakAdapter.getTokenUrl()
    const bodyObj: TokenRequestBody = { ...body }
    noStore(set)

    logger.auth.debug('Token endpoint request', {
      grant_type: bodyObj.grant_type || 'MISSING',
      client_id: bodyObj.client_id || 'MISSING',
      has_code: !!bodyObj.code,
    })

    // private_key_jwt: validate the client's assertion, then re-sign it with the proxy's key so
    // Keycloak's federated client authentication accepts it whatever aud the client used.
    if (hasClientAssertion(bodyObj)) {
      try {
        const { clientId, proxyAssertion } = await translateClientAssertion(bodyObj.client_assertion ?? '', bodyObj.client_id)
        bodyObj.client_assertion = proxyAssertion
        if (!bodyObj.client_id) bodyObj.client_id = clientId
      } catch (err) {
        if (err instanceof ClientAssertionError) return oauthError(set, err.httpStatus, err.oauthError, err.description)
        throw err
      }
    }

    const clientRedirectUri = bodyObj.redirect_uri
    const basicAuth = clientBasicAuth(headers.authorization)
    const clientIdForSession = bodyObj.client_id || basicAuth?.clientId
    const smartDeps = { config: smartProxyConfig, store: smartStore, logger: smartLogger }
    const authCode = bodyObj.code
    const grantType = bodyObj.grant_type

    if (grantType === 'authorization_code') {
      const redemption = verifyCodeRedemption({ clientId: clientIdForSession, redirectUri: clientRedirectUri, code: authCode }, smartDeps)
      if (!redemption.ok) return oauthError(set, 400, redemption.error, redemption.description)
    }

    const rewrittenUri = getRewrittenRedirectUri(clientIdForSession, clientRedirectUri, authCode, smartDeps)
    // RFC 8707: Keycloak answers ERROR_NOT_MATCHING unless the resource captured at /authorize is re-sent.
    const sessionAud = getSessionAudience(clientIdForSession, clientRedirectUri, authCode, smartDeps)

    const requestedResource = bodyObj.resource
    if (grantType === 'client_credentials') {
      const resource = await clientCredentialsResource(requestedResource)
      if (resource === null) return oauthError(set, 400, 'invalid_target', `No resource server is registered for ${requestedResource}`)
      bodyObj.resource = resource
    }
    const defaultedResource = grantType === 'client_credentials' && !requestedResource && !!bodyObj.resource

    if (grantType === TOKEN_EXCHANGE_GRANT && bodyObj.resource && !bodyObj.audience) {
      const audience = await resourceAudienceResolver.audienceFor(bodyObj.resource)
      if (!audience) return oauthError(set, 400, 'invalid_target', `No resource server is registered for ${bodyObj.resource}`)
      bodyObj.audience = audience
    }

    const requestToken = (resource: string | undefined) => fetch(kcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(basicAuth && { Authorization: basicAuth.header }),
      },
      body: buildKeycloakForm(bodyObj, { redirectUri: rewrittenUri || clientRedirectUri, resource }).toString(),
    })

    let resp = await requestToken(sessionAud ?? bodyObj.resource)
    let data: TokenResponseBody = requireRecord(await resp.json(), 'Keycloak token response')

    // A client without the resource-indicators scope cannot be bound; it keeps the unbound token it had before.
    if (defaultedResource && resp.status === 400 && data.error === 'invalid_target') {
      logger.auth.warn('Client cannot be bound to the FHIR server, issuing an unbound token', { clientId: clientIdForSession })
      if (hasClientAssertion(bodyObj) && clientIdForSession) bodyObj.client_assertion = signProxyAssertion(clientIdForSession)
      resp = await requestToken(undefined)
      data = requireRecord(await resp.json(), 'Keycloak token response')
    }
    const issued = resp.status === 200 && typeof data.access_token === 'string' ? data.access_token : null

    const exchange = issued && grantType === TOKEN_EXCHANGE_GRANT && bodyObj.subject_token
      ? await resolveExchange(bodyObj.subject_token, issued)
      : null

    await logTokenEvent({
      path: '/auth/token',
      clientId: clientIdForSession || 'unknown',
      grantType: grantType || 'unknown',
      ...(exchange && { actorChain: actorChain(exchange.act) }),
      scope: bodyObj.scope,
      status: resp.status,
      responseTime: Date.now() - startTime,
      headers,
      ipAddress: clientIp(request, { server }),
      data,
    })

    set.status = resp.status
    if (data.error || !issued) return data

    // Keycloak accepted the refresh token, which is what lets its context be handed on.
    const carried = grantType === 'refresh_token' && bodyObj.refresh_token
      ? await carriedRefreshContext(bodyObj.refresh_token, clientIdForSession)
      : null

    await applyLaunchContext(data, {
      accessToken: issued,
      clientId: clientIdForSession,
      redirectUri: clientRedirectUri,
      code: authCode,
      sessionAud: sessionAud ?? undefined,
      grantType,
      exchange,
      carried,
    })

    // SMART: a patient-restricted grant SHALL come with a patient in context; a launch deferred past the callback that found none ends here.
    if (grantType === 'authorization_code' && !data.patient && hasPatientCompartmentScope(parseScopes(typeof data.scope === 'string' ? data.scope : ''))) {
      logger.auth.warn('Token refused: patient-level scopes granted but no patient could be established', { clientId: clientIdForSession })
      return oauthError(set, 400, 'invalid_grant', 'No patient could be established for the patient-level scopes this authorization grants')
    }

    return data
  }, {
    transform: authEndpointRateLimit(),
    parse: parseFormBody,
    body: TokenRequest,
    response: { 200: TokenResponse },
    detail: { summary: 'OAuth Token Exchange', description: 'Exchange authorization code for access token with SMART launch context', tags: ['authentication'] }
  })

  // ── Device authorization endpoint (RFC 8628) ──────────────────────────
  // Fronts Keycloak's device-authorization endpoint so CLI / device clients begin the device grant
  // at the proxy. Keycloak's JSON is returned as-is, verification_uri included; the device_code
  // poll then happens at /auth/token above.
  .post('/device', async ({ body, set, headers, request, server }) => {
    const startTime = Date.now()
    const deviceUrl = keycloakAdapter.getDeviceAuthorizationUrl?.()
    const bodyObj: TokenRequestBody = { ...body }

    if (!deviceUrl) {
      return oauthError(set, 501, 'unsupported', 'Device authorization is not supported by this authorization server')
    }

    logger.auth.debug('Device authorization request', {
      client_id: bodyObj.client_id || 'MISSING',
      has_scope: !!bodyObj.scope,
    })

    const formData = new URLSearchParams()
    for (const [key, value] of Object.entries(bodyObj)) {
      if (value !== undefined && value !== '') formData.append(key, value)
    }

    const resp = await fetch(deviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    })

    const data: TokenResponseBody = requireRecord(await resp.json(), 'Keycloak device authorization response')

    await logTokenEvent({
      path: '/auth/device',
      clientId: bodyObj.client_id || 'unknown',
      grantType: 'device_authorization',
      scope: bodyObj.scope,
      status: resp.status,
      responseTime: Date.now() - startTime,
      headers,
      ipAddress: clientIp(request, { server }),
      data,
    })

    set.status = resp.status
    noStore(set)
    return data
  }, {
    transform: authEndpointRateLimit(),
    parse: parseFormBody,
    body: DeviceAuthorizationRequest,
    response: { 200: DeviceAuthorizationResponse },
    detail: { summary: 'OAuth Device Authorization (RFC 8628)', description: 'Begin the device authorization grant through the proxy. Forwards to the authorization server device endpoint and returns the device_code / user_code response.', tags: ['authentication'] }
  })
