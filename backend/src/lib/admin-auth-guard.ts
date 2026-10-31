// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Baseline admin auth for every admin route; `.guard({ detail: { security } })` is OpenAPI-only and enforces nothing.

import { Elysia } from 'elysia'
import { extractBearerToken, AuthenticationError, AuthorizationError } from './admin-utils'
import { validateToken, validateAdminToken } from './auth'
import { logger } from './logger'
import { config } from '../config'
import type { AdminAccess } from './admin-roles'

// Empty by design; exact pathname match.
const PUBLIC_ADMIN_PATHS = new Set<string>()

function isPublicAdminPath(pathname: string): boolean {
  return PUBLIC_ADMIN_PATHS.has(pathname)
}

// Add a prefix only once its handlers also request 'read' access.
const AUDITOR_READABLE_PREFIXES: readonly string[] = ['/admin/idps', '/admin/monitoring']
const SAFE_METHODS = new Set(['GET', 'HEAD'])

function requestedAccess(method: string, pathname: string): AdminAccess {
  const readable = AUDITOR_READABLE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  return SAFE_METHODS.has(method) && readable ? 'read' : 'write'
}

// Scoped: propagates to the app mounting adminRoutes only; registered after the audit plugin so 401/403s are audited.
export const adminAuthGuard = new Elysia({ name: 'admin-auth-guard' })
  .onBeforeHandle({ as: 'scoped' }, async ({ request, headers, set }) => {
    const pathname = new URL(request.url).pathname
    if (isPublicAdminPath(pathname)) return

    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Unauthorized', details: 'Bearer token required' }
    }

    try {
      await validateToken(token)
    } catch (error) {
      logger.auth.warn('Admin guard rejected token (invalid)', {
        path: pathname,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      set.status = 401
      return { error: 'Unauthorized', details: 'Invalid or expired token' }
    }

    try {
      await validateAdminToken(token, requestedAccess(request.method, pathname))
    } catch (error) {
      if (error instanceof AuthorizationError) {
        logger.auth.warn('Admin guard rejected token (insufficient roles)', {
          path: pathname,
          error: error.message,
        })
        set.status = 403
        return { error: 'Forbidden', details: 'Admin role required for this deployment' }
      }
      if (error instanceof AuthenticationError) {
        logger.auth.warn('Admin guard rejected token (not an admin-client token)', {
          path: pathname,
          error: error.message,
        })
        set.status = 403
        return {
          error: 'Forbidden',
          details: `Token is not for an admin client (expected ${config.keycloak.adminUiClientId} or ${config.keycloak.adminClientId ?? 'the admin service account'})`,
        }
      }
      logger.auth.error('Admin guard encountered unexpected error', {
        path: pathname,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      set.status = 401
      return { error: 'Unauthorized', details: 'Authentication failed' }
    }
  })
