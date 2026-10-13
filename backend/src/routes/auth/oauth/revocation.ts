// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * RFC 7009 token revocation, fronting Keycloak's revoke endpoint so clients never need its URL.
 */

import { Elysia } from 'elysia'
import fetch from 'cross-fetch'
import { logger } from '@/lib/logger'
import { clientBasicAuth } from '@/lib/http-auth'
import { readUnverifiedClaims } from '@/lib/jwt-claims'
import { isRecord } from '@/lib/type-guards'
import { tokenContextStore } from '@/lib/token-context-store'
import { markTokenRevoked } from '@/lib/revoked-tokens'
import { authEndpointRateLimit } from '@/lib/rate-limit'
import { RevocationRequest, type RevocationRequestType } from '@/schemas'
import { hasClientAssertion, translateClientAssertion, ClientAssertionError } from '../backend-services'
import { keycloakAdapter } from '../smart-proxy-setup'
import { parseFormBody } from './shared'

interface OAuthError {
  error: string
  error_description?: string
}

/** The OAuth error in a Keycloak response body, or null for an empty or non-error body. */
async function readOAuthError(resp: Response): Promise<OAuthError | null> {
  const text = await resp.text()
  if (!text) return null
  try {
    const body: unknown = JSON.parse(text)
    if (!isRecord(body) || typeof body.error !== 'string') return null
    return {
      error: body.error,
      ...(typeof body.error_description === 'string' && { error_description: body.error_description }),
    }
  } catch {
    return null
  }
}

function forwardedForm(body: RevocationRequestType): Record<string, string> {
  const form: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value) form[key] = value
  }
  return form
}

export const revocationRoutes = new Elysia({ tags: ['authentication'] })

  .post('/revoke', async ({ body, set, headers }) => {
    set.headers['Cache-Control'] = 'no-store'
    set.headers['Pragma'] = 'no-cache'

    if (!body.token) {
      set.status = 400
      return { error: 'invalid_request', error_description: 'The token parameter is required' }
    }

    const form = forwardedForm(body)
    if (hasClientAssertion(body)) {
      try {
        const { clientId, proxyAssertion } = await translateClientAssertion(body.client_assertion ?? '', body.client_id)
        form.client_assertion = proxyAssertion
        form.client_id = clientId
      } catch (err) {
        if (!(err instanceof ClientAssertionError)) throw err
        set.status = err.httpStatus
        return { error: err.oauthError, error_description: err.description }
      }
    }

    // RFC 7009 §2.1: confidential clients authenticate; a public client identifies itself with client_id.
    const basicAuth = clientBasicAuth(headers.authorization)
    const clientId = basicAuth?.clientId ?? form.client_id
    if (!clientId) {
      set.status = 401
      set.headers['WWW-Authenticate'] = 'Basic realm="token revocation"'
      return { error: 'invalid_client', error_description: 'Token revocation requires client authentication or a client_id' }
    }

    const revocationUrl = keycloakAdapter.getRevocationUrl?.()
    if (!revocationUrl) {
      set.status = 501
      return { error: 'unsupported', error_description: 'Token revocation is not supported by this authorization server' }
    }

    try {
      const resp = await fetch(revocationUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(basicAuth && { Authorization: basicAuth.header }),
        },
        body: new URLSearchParams(form).toString(),
      })
      const failure = await readOAuthError(resp)

      if (resp.ok && !failure) {
        const claims = readUnverifiedClaims(body.token)
        if (claims?.jti) {
          await markTokenRevoked(claims.jti, claims.exp)
          await tokenContextStore.delete(claims.jti, clientId)
        }
        logger.auth.info('Token revoked', { clientId, tokenTypeHint: body.token_type_hint })
        set.status = 200
        return ''
      }

      // RFC 7009 §2.2: an invalid token is not an error, there is simply nothing left to revoke.
      if (failure?.error === 'invalid_token') {
        set.status = 200
        return ''
      }

      logger.auth.warn('Token revocation refused', { clientId, status: resp.status, error: failure?.error })
      set.status = resp.ok ? 400 : resp.status
      return failure ?? { error: 'invalid_request', error_description: 'Token revocation failed' }
    } catch (error) {
      logger.auth.error('Token revocation endpoint error', { error })
      set.status = 500
      return { error: 'server_error', error_description: 'Failed to process the revocation request' }
    }
  }, {
    parse: parseFormBody,
    transform: authEndpointRateLimit(),
    body: RevocationRequest,
    detail: {
      summary: 'OAuth Token Revocation (RFC 7009)',
      description: 'Revoke an access or refresh token. Confidential clients authenticate with HTTP Basic, client_secret or a private_key_jwt assertion; a public client sends its client_id. An unknown or invalid token answers 200.',
      tags: ['authentication'],
    },
  })
