// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Context } from 'elysia'
import { AuthenticationError, AuthorizationError } from './admin-utils'
import { logger } from './logger'
import { errorResponseStatus, isRecord } from './type-guards'

/**
 * Maps admin-route errors to responses: 401 when the token was not accepted, 403 when the grant is
 * insufficient (clients retry 401s), else Keycloak's own status, else 500.
 */
export function handleAdminError(error: unknown, set: Context['set']) {
  logger.admin.info('HTTP Error in admin endpoint', { error })

  if (error instanceof AuthorizationError) {
    logger.admin.warn('AuthorizationError detected, returning 403', { reason: error.message })
    set.status = 403
    return { error: 'Forbidden', details: error.message }
  }

  if (error instanceof AuthenticationError) {
    logger.admin.warn('AuthenticationError detected, returning 401', { reason: error.message })
    set.status = 401
    return { error: 'Unauthorized', details: error.message }
  }

  const keycloakStatus = errorResponseStatus(error)

  if (keycloakStatus) {
    logger.admin.warn(`Returning Keycloak status: ${keycloakStatus}`)
    set.status = keycloakStatus
    
    // The proxy already accepted this token, so a 401 here names Keycloak as the rejecting hop.
    if (keycloakStatus === 401) {
      return { error: 'Unauthorized', details: 'Keycloak rejected the forwarded access token' }
    } else if (keycloakStatus === 403) {
      // A specific refusal, e.g. an IdP mapper granting an admin role without allowAdminRoleMapping (26.8).
      return {
        error: 'Forbidden',
        details: keycloakErrorMessage(error)
          ?? 'Keycloak refused this operation for the caller\'s realm-management roles',
      }
    } else {
      return { error: 'Keycloak error', details: sanitizeErrorForResponse(error) }
    }
  }
  
  logger.admin.error('Unknown error, returning 500')
  set.status = 500
  return { error: 'Internal server error', details: sanitizeErrorForResponse(error) }
}

/** Error detail without stack traces; Keycloak's response body wins, since its admin client's message is only the error code. */
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

/** The parsed bodies the admin client attaches to a failed request. */
function keycloakErrorBodies(error: unknown): Record<string, unknown>[] {
  if (!isRecord(error)) return []
  const response = isRecord(error.response) ? error.response : undefined
  return [error.responseData, response?.data, response?.body].filter(isRecord)
}

/** Keycloak's own explanation (`errorMessage`), absent on its generic permission refusals. */
function keycloakErrorMessage(error: unknown): string | undefined {
  for (const body of keycloakErrorBodies(error)) {
    if (typeof body.errorMessage === 'string' && body.errorMessage.trim()) return body.errorMessage
  }
  return undefined
}

/** Every description Keycloak returned, across `error_description`, `errorMessage` and `error`. */
function keycloakErrorDetail(error: unknown): string | null {
  const parts: string[] = []
  for (const body of keycloakErrorBodies(error)) {
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


