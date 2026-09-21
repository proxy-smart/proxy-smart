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
import { tokenContextStore } from '@/lib/token-context-store'
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
  .post('/introspect', async ({ body, set }) => {
    const kcUrl = keycloakAdapter.getIntrospectionUrl()
    const bodyObj = body as Record<string, string>

    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    // A bare `client_id` (public SMART client, e.g. Inferno) is NOT usable
    // introspection auth: RFC 7662 requires the CALLER to authenticate, and
    // Keycloak rejects a public client at the introspection endpoint, returning
    // {"active": false} for an otherwise-valid token. Only real credentials
    // (client_secret / client_assertion) count as caller auth; otherwise fall
    // back to the proxy's configured introspection client and strip the partial
    // client id so Keycloak doesn't see two competing auth methods.
    const forwardBody: Record<string, string> = { ...bodyObj }
    const hasClientAuth = bodyObj.client_secret || bodyObj.client_assertion
    if (!hasClientAuth) {
      const auth = keycloakAdapter.getIntrospectionAuth?.()
      if (auth) {
        headers['Authorization'] = `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`
        delete forwardBody.client_id
        delete forwardBody.client_secret
      }
    }

    const resp = await fetch(kcUrl, {
      method: 'POST', headers,
      body: new URLSearchParams(forwardBody).toString()
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
        const introspectingClientId = bodyObj.client_id || (typeof data.client_id === 'string' ? data.client_id : undefined)
        const storedContext = tokenContextStore.get(jti, introspectingClientId)
        if (storedContext) {
          if (storedContext.patient && !data.patient) data.patient = storedContext.patient
          if (storedContext.encounter && !data.encounter) data.encounter = storedContext.encounter
          if (storedContext.fhirUser && !data.fhirUser) data.fhirUser = storedContext.fhirUser
          if (storedContext.intent && !data.intent) data.intent = storedContext.intent
        }
      }
    }

    // Enrich with SMART-standard claim names (fhir_user→fhirUser, patient derivation from fhirUser)
    enrichIntrospection(data)

    return data
  }, {
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
