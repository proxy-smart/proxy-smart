// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * RFC 6749 §5.2 error responses for the proxy's OAuth endpoints, and the boundary that turns
 * framework failures on those endpoints (schema validation, unparsable bodies, thrown errors)
 * into the same shape instead of Elysia's default 422 / plain-text 500.
 */

import { Elysia, ValidationError } from 'elysia'
import { logger } from './logger'

export interface OAuthErrorBody {
  error: string
  error_description?: string
}

interface ResponseControl {
  status?: number | string
  headers: Record<string, string | number>
}

/** RFC 6749 §5.1: token-bearing and error responses are never cached. */
export function noStore(set: ResponseControl): void {
  set.headers['Cache-Control'] = 'no-store'
  set.headers['Pragma'] = 'no-cache'
}

export function oauthError(set: ResponseControl, status: number, error: string, description?: string): OAuthErrorBody {
  set.status = status
  noStore(set)
  return { error, ...(description && { error_description: description }) }
}

const OAUTH_ENDPOINTS = ['/auth/token', '/auth/introspect', '/auth/revoke', '/auth/register', '/auth/device'] as const

/** RFC 7591 §3.2.2 names its own code for a registration body that does not validate. */
const REQUEST_ERROR_BY_ENDPOINT: Partial<Record<(typeof OAUTH_ENDPOINTS)[number], string>> = {
  '/auth/register': 'invalid_client_metadata',
}

function oauthEndpointOf(pathname: string): (typeof OAUTH_ENDPOINTS)[number] | undefined {
  return OAUTH_ENDPOINTS.find((endpoint) => pathname === endpoint || pathname.startsWith(`${endpoint}/`))
}

function requestProblem(error: ValidationError): string {
  const issue = error.valueError
  if (!issue) return `Invalid ${error.type}`
  return issue.path ? `Invalid ${error.type} at ${issue.path}: ${issue.message}` : `Invalid ${error.type}: ${issue.message}`
}

export const oauthErrorBoundary = new Elysia({ name: 'oauth-error-boundary' })
  .onError({ as: 'global' }, ({ code, error, set, request }) => {
    const endpoint = oauthEndpointOf(new URL(request.url).pathname)
    if (!endpoint) return

    if (error instanceof ValidationError && error.type !== 'response') {
      return oauthError(set, 400, REQUEST_ERROR_BY_ENDPOINT[endpoint] ?? 'invalid_request', requestProblem(error))
    }
    if (code === 'PARSE') {
      return oauthError(set, 400, REQUEST_ERROR_BY_ENDPOINT[endpoint] ?? 'invalid_request', 'The request body could not be parsed')
    }
    if (code === 'VALIDATION' || code === 'UNKNOWN' || code === 'INTERNAL_SERVER_ERROR') {
      logger.auth.error('OAuth endpoint failed', {
        endpoint,
        error: error instanceof Error ? error.message : String(error),
      })
      return oauthError(set, 500, 'server_error', 'The authorization server could not process the request')
    }
  })
