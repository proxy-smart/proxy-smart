// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Context } from 'elysia'
import { AuthenticationError, AuthorizationError } from './admin-utils'
import { logger } from './logger'
import { isRecord } from './type-guards'

/**
 * Centralized error handler for admin routes that use Keycloak
 * Handles authentication errors and Keycloak status code propagation
 *
 * Status semantics match the admin guard: 401 means the token itself was not
 * accepted, 403 means it was and the grant is insufficient. Keeping them apart
 * matters to clients, which refresh and retry on 401 — doing that for a missing
 * role produces an endless loop, since the new token is just as insufficient.
 */
export function handleAdminError(error: unknown, set: Context['set']) {
  logger.admin.info('HTTP Error in admin endpoint', { error })

  // Authentic token, insufficient grant. Used to fall through to the 500 branch.
  if (error instanceof AuthorizationError) {
    logger.admin.warn('AuthorizationError detected, returning 403', { reason: error.message })
    set.status = 403
    return { error: 'Forbidden', details: error.message }
  }

  if (error instanceof AuthenticationError) {
    logger.admin.warn('AuthenticationError detected, returning 401', { reason: error.message })
    set.status = 401
    // The reason, not a fixed "Authorization header required" — that answer was actively
    // misleading for every 401 raised by something other than a missing header.
    return { error: 'Unauthorized', details: error.message }
  }

  // Extract actual HTTP status from Keycloak response if available
  const response = isRecord(error) && isRecord(error.response) ? error.response : undefined
  const keycloakStatus = response?.status

  if (keycloakStatus && typeof keycloakStatus === 'number') {
    logger.admin.warn(`Returning Keycloak status: ${keycloakStatus}`)
    set.status = keycloakStatus
    
    // Return appropriate response based on status. Name Keycloak as the rejecting party —
    // the proxy already accepted this token, so an unqualified "Unauthorized" points the
    // reader at the wrong hop.
    if (keycloakStatus === 401) {
      return { error: 'Unauthorized', details: 'Keycloak rejected the forwarded access token' }
    } else if (keycloakStatus === 403) {
      return {
        error: 'Forbidden',
        details: 'Keycloak refused this operation for the caller\'s realm-management roles',
      }
    } else {
      return { error: 'Keycloak error', details: sanitizeErrorForResponse(error) }
    }
  }
  
  // Fallback to 500 for unknown errors
  logger.admin.error('Unknown error, returning 500')
  set.status = 500
  return { error: 'Internal server error', details: sanitizeErrorForResponse(error) }
}

/**
 * Sanitize error details before sending in HTTP response.
 * Removes stack traces and internal file paths to prevent information disclosure.
 *
 * Prefers Keycloak's own response body over `error.message`. The admin client throws
 * with the message set to just the error CODE, so a failed provider create surfaced as
 * the bare word `unknown_error` while the body carried the actual reason. Reporting the
 * code alone is indistinguishable from reporting nothing.
 */
function sanitizeErrorForResponse(error: unknown): string {
  const fromKeycloak = keycloakErrorDetail(error)
  if (fromKeycloak) return fromKeycloak
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'An unexpected error occurred'
}

/**
 * The most specific description Keycloak returned, across the field names its various
 * endpoints use (`error_description`, `errorMessage`, `error`) and the two places the
 * admin client stashes the parsed body.
 */
function keycloakErrorDetail(error: unknown): string | null {
  if (!isRecord(error)) return null
  const response = isRecord(error.response) ? error.response : undefined
  const bodies = [error.responseData, response?.data, response?.body].filter(isRecord)

  const parts: string[] = []
  for (const body of bodies) {
    for (const field of ['error_description', 'errorMessage', 'error']) {
      const value = body[field]
      if (typeof value === 'string' && value.trim() && !parts.includes(value)) parts.push(value)
    }
  }
  if (parts.length === 0) return null

  // A message plus the code reads better than either alone, and the code is what
  // Keycloak's own docs are searchable by.
  return parts.join(': ')
}


