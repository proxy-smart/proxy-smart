// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Introspection and userinfo: what a resource server and an app ask about a
 * token they already hold.
 */

import { Elysia } from 'elysia'
import { config } from '@/config'
import { validateToken } from '@/lib/auth'
import { extractBearerToken } from '@/lib/admin-utils'
import { tokenContextStore, type TokenContext } from '@/lib/token-context-store'
import { basicAuthHeader, clientBasicAuth } from '@/lib/http-auth'
import { readKeycloakClaims, readUnverifiedClaims } from '@/lib/jwt-claims'
import { realmRoles } from '@/lib/admin-roles'
import { authEndpointRateLimit } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { requireRecord } from '@/lib/type-guards'
import { noStore, oauthError, type OAuthErrorBody } from '@/lib/oauth-errors'
import { hasClientAssertion, translateClientAssertion, ClientAssertionError } from '../backend-services'
import { keycloakAdapter } from '../smart-proxy-setup'
import { enrichIntrospection, parseScopes } from '@proxy-smart/auth'
import {
  IntrospectRequest,
  IntrospectResponse,
  UserInfoHeader,
  UserInfoResponse,
  UserInfoErrorResponse,
} from '@/schemas'

type IntrospectionBody = Record<string, unknown>

/** The token response's launch context and scope, which introspection repeats (SMART 2.2 §Token Introspection). */
const INTROSPECTED_CONTEXT = [
  'patient', 'encounter', 'fhirUser', 'fhirContext', 'intent', 'smart_style_url', 'tenant', 'need_patient_banner', 'act', 'scope',
] as const satisfies readonly (keyof TokenContext)[]

/** The request parameters a bearer caller's introspection forwards; any client credentials stay behind. */
const FORWARDED_FOR_BEARER_CALLERS = ['token', 'token_type_hint'] as const

interface KeycloakIntrospection {
  headers: Record<string, string>
  form: Record<string, string>
}

interface ResponseControl {
  status?: number | string
  headers: Record<string, string | number>
}

/**
 * SMART 2.2: a client authorized to introspect SHALL be able to authenticate with an
 * appropriately-scoped SMART bearer token. Such a caller may introspect any client's token, so
 * Keycloak is asked as the proxy's own introspection client, which is exempt from its audience check.
 */
async function asBearerCaller(token: string, form: Record<string, string>, set: ResponseControl): Promise<KeycloakIntrospection | OAuthErrorBody> {
  const realm = 'token introspection'
  let scopes: Set<string>
  try {
    const payload = await validateToken(token, { enforceAudience: false })
    scopes = parseScopes(typeof payload.scope === 'string' ? payload.scope : undefined)
  } catch {
    set.headers['WWW-Authenticate'] = `Bearer realm="${realm}", error="invalid_token"`
    return oauthError(set, 401, 'invalid_token', 'The bearer token is invalid or expired')
  }

  const required = config.smart.introspectionScope
  if (!scopes.has(required)) {
    set.headers['WWW-Authenticate'] = `Bearer realm="${realm}", error="insufficient_scope", scope="${required}"`
    return oauthError(set, 403, 'insufficient_scope', `Token introspection requires the ${required} scope`)
  }

  const { adminClientId, adminClientSecret } = config.keycloak
  if (!adminClientId || !adminClientSecret) {
    logger.auth.error('Bearer introspection needs KEYCLOAK_ADMIN_CLIENT_ID and KEYCLOAK_ADMIN_CLIENT_SECRET')
    return oauthError(set, 500, 'server_error', 'Token introspection is not configured for bearer callers')
  }

  const forwarded: Record<string, string> = {}
  for (const key of FORWARDED_FOR_BEARER_CALLERS) {
    if (form[key]) forwarded[key] = form[key]
  }
  return {
    headers: { Authorization: basicAuthHeader(encodeURIComponent(adminClientId), encodeURIComponent(adminClientSecret)) },
    form: forwarded,
  }
}

/** RFC 7662 §2.1: the caller authenticates as itself; a bare client_id only names a client. */
async function introspectionCaller(
  authorization: string | undefined,
  form: Record<string, string>,
  set: ResponseControl,
): Promise<KeycloakIntrospection | OAuthErrorBody> {
  const bearer = extractBearerToken({ authorization })
  if (bearer) return asBearerCaller(bearer, form, set)

  const basicAuth = clientBasicAuth(authorization)
  if (hasClientAssertion(form)) {
    try {
      const { clientId, proxyAssertion } = await translateClientAssertion(form.client_assertion ?? '', form.client_id)
      return { headers: {}, form: { ...form, client_assertion: proxyAssertion, client_id: clientId } }
    } catch (err) {
      if (!(err instanceof ClientAssertionError)) throw err
      return oauthError(set, err.httpStatus, err.oauthError, err.description)
    }
  }
  if (basicAuth) return { headers: { Authorization: basicAuth.header }, form }
  if (form.client_secret) return { headers: {}, form }

  set.headers['WWW-Authenticate'] = 'Basic realm="token introspection"'
  return oauthError(set, 401, 'invalid_client', 'Token introspection requires client authentication')
}

const isOAuthError = (value: KeycloakIntrospection | OAuthErrorBody): value is OAuthErrorBody => 'error' in value

export const introspectionRoutes = new Elysia({ tags: ['authentication'] })

  // ── Introspection (delegates enrichment to @proxy-smart/auth) ─────────
  .post('/introspect', async ({ body, set, headers: requestHeaders }) => {
    noStore(set)
    const caller = await introspectionCaller(requestHeaders.authorization, body, set)
    if (isOAuthError(caller)) return caller

    const resp = await fetch(keycloakAdapter.getIntrospectionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...caller.headers },
      body: new URLSearchParams(caller.form).toString(),
    })

    const data: IntrospectionBody = requireRecord(await resp.json(), 'Keycloak introspection response')
    set.status = resp.status

    // The token context store is authoritative (it holds the absolute fhirUser and the scope the
    // token response carried), the raw JWT claim is the fallback, and enrichIntrospection derives
    // patient from fhirUser last.
    if (data.active && body.token) {
      const claims = readUnverifiedClaims(body.token)
      const jti = typeof claims?.jti === 'string' ? claims.jti : undefined
      // Keycloak's active verdict already authorized the caller; the binding only ties the
      // stored context to the app this token was issued to.
      const issuedTo = typeof data.client_id === 'string' ? data.client_id : undefined
      const storedContext = jti ? await tokenContextStore.get(jti, issuedTo) : null
      for (const key of INTROSPECTED_CONTEXT) {
        const value = storedContext?.[key]
        if (value !== undefined) data[key] = value
      }
      if (!data.fhirUser && !data.fhir_user && typeof claims?.fhirUser === 'string') data.fhirUser = claims.fhirUser
    }

    enrichIntrospection(data)

    return data
  }, {
    transform: authEndpointRateLimit(),
    body: IntrospectRequest,
    response: { 200: IntrospectResponse },
    detail: {
      summary: 'Token Introspection',
      description: 'Validate and get information about an access token. Callers authenticate as a client (HTTP Basic, client_secret or private_key_jwt) or with a SMART bearer token carrying the introspection scope.',
      tags: ['authentication'],
    }
  })

  // ── User info ─────────────────────────────────────────────────────────
  .get('/userinfo', async ({ headers, set }) => {
    if (!headers.authorization) {
      set.status = 401
      set.headers['WWW-Authenticate'] = `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`
      return { error: 'Unauthorized' }
    }

    const token = headers.authorization.replace('Bearer ', '')
    try {
      const payload = await validateToken(token)
      const displayName = payload.name ||
        (payload.given_name && payload.family_name ? `${payload.given_name} ${payload.family_name}` : '') ||
        payload.given_name || payload.preferred_username || payload.email || 'User'

      return {
        id: payload.sub || '',
        fhirUser: payload.fhirUser || '',
        name: [{ text: displayName }],
        username: payload.preferred_username || '',
        email: payload.email,
        firstName: payload.given_name,
        lastName: payload.family_name,
        roles: realmRoles(readKeycloakClaims(payload))
      }
    } catch {
      set.status = 401
      return { error: 'Invalid token' }
    }
  }, {
    headers: UserInfoHeader,
    response: { 200: UserInfoResponse, 401: UserInfoErrorResponse },
    detail: { summary: 'Get Current User Profile', description: 'Get authenticated user profile from JWT token', tags: ['authentication'], security: [{ BearerAuth: [] }] }
  })
