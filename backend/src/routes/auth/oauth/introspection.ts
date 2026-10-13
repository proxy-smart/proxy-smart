// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Introspection and userinfo: what a resource server and an app ask about a
 * token they already hold.
 */

import { Elysia } from 'elysia'
import fetch from 'cross-fetch'
import { config } from '@/config'
import { validateToken } from '@/lib/auth'
import { tokenContextStore, type TokenContext } from '@/lib/token-context-store'
import { clientBasicAuth } from '@/lib/http-auth'
import { authEndpointRateLimit } from '@/lib/rate-limit'
import { keycloakAdapter } from '../smart-proxy-setup'
import { enrichIntrospection } from '@proxy-smart/auth'
import {
  IntrospectRequest,
  IntrospectResponse,
  UserInfoHeader,
  UserInfoResponse,
  UserInfoErrorResponse,
} from '@/schemas'

type IntrospectionBody = Record<string, unknown>

/** The token response's launch context, which introspection repeats (SMART 2.2 §Token Introspection). */
const INTROSPECTED_CONTEXT = [
  'patient', 'encounter', 'fhirUser', 'fhirContext', 'intent', 'smart_style_url', 'tenant', 'need_patient_banner', 'act',
] as const satisfies readonly (keyof TokenContext)[]

/** JTI plus any claims Keycloak did not echo back, read straight off the JWT. */
function readJwtFallbacks(token: string, data: IntrospectionBody): string | undefined {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return undefined

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    if (!data.fhirUser && !data.fhir_user && payload.fhirUser) {
      data.fhirUser = payload.fhirUser
    }
    return typeof payload.jti === 'string' ? payload.jti : undefined
  } catch {
    // Opaque token — nothing to decode.
    return undefined
  }
}

export const introspectionRoutes = new Elysia({ tags: ['authentication'] })

  // ── Introspection (delegates enrichment to @proxy-smart/auth) ─────────
  .post('/introspect', async ({ body, set, headers: requestHeaders }) => {
    const kcUrl = keycloakAdapter.getIntrospectionUrl()
    const bodyObj = body as Record<string, string>

    // RFC 7662 §2.1: the caller authenticates as itself. A bare client_id only names a client,
    // and Keycloak then answers for that caller, so a token not meant for it reads inactive.
    const basicAuth = clientBasicAuth(requestHeaders.authorization)
    if (!basicAuth && !bodyObj.client_secret && !bodyObj.client_assertion) {
      set.status = 401
      set.headers['WWW-Authenticate'] = 'Basic realm="token introspection"'
      set.headers['Cache-Control'] = 'no-store'
      return { error: 'invalid_client', error_description: 'Token introspection requires client authentication' }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    if (basicAuth) headers['Authorization'] = basicAuth.header

    const resp = await fetch(kcUrl, {
      method: 'POST', headers,
      body: new URLSearchParams(bodyObj).toString()
    })

    const data: IntrospectionBody = await resp.json()
    set.status = resp.status
    set.headers['Cache-Control'] = 'no-store'
    set.headers['Pragma'] = 'no-cache'

    // ── SMART launch context recovery for introspection (§5.2) ──────
    // Priority: the token context store is authoritative, the JWT payload is
    // the fallback, and enrichIntrospection derives patient from fhirUser last.
    if (data.active && bodyObj.token) {
      const jti = readJwtFallbacks(bodyObj.token, data)

      if (jti) {
        // Keycloak's active verdict already authorized the caller; the binding only ties the
        // stored context to the app this token was issued to.
        const issuedTo = typeof data.client_id === 'string' ? data.client_id : undefined
        const storedContext = await tokenContextStore.get(jti, issuedTo)
        for (const key of INTROSPECTED_CONTEXT) {
          const value = storedContext?.[key]
          if (value !== undefined && data[key] === undefined) data[key] = value
        }
      }
    }

    // Enrich with SMART-standard claim names (fhir_user→fhirUser, patient derivation from fhirUser)
    enrichIntrospection(data)

    return data
  }, {
    transform: authEndpointRateLimit(),
    body: IntrospectRequest,
    response: { 200: IntrospectResponse },
    detail: { summary: 'Token Introspection', description: 'Validate and get information about an access token', tags: ['authentication'] }
  })

  // ── User info ─────────────────────────────────────────────────────────
  .get('/userinfo', async ({ headers, set }) => {
    if (!headers.authorization) {
      set.status = 401
      ;(set.headers as Record<string, string>)['WWW-Authenticate'] = `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`
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
        roles: payload.realm_access?.roles || []
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
