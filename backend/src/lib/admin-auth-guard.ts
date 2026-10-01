// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Admin Authentication Guard
 *
 * Single choke point that requires a valid Keycloak admin token before any admin
 * handler runs, whether or not the handler calls validateAdminToken itself.
 * `.guard({ detail: { security } })` is OpenAPI metadata only and enforces nothing.
 *
 * Status semantics (aligned with the rest of the codebase):
 *   - missing bearer token          → 401 (Authorization header required)
 *   - signature/expiry/issuer fail  → 401 (invalid token)
 *   - valid token, no admin role    → 403 (insufficient permissions)
 *
 * Defense-in-depth: handlers that already call validateAdminToken / getAdmin(token)
 * keep doing so — this guard does not replace per-handler Keycloak RBAC, it ensures
 * a baseline that cannot be forgotten.
 */

import { Elysia } from 'elysia'
import { extractBearerToken, AuthenticationError, AuthorizationError } from './admin-utils'
import { validateToken, validateAdminToken } from './auth'
import { logger } from './logger'
import { config } from '../config'

/**
 * Paths (relative to the `/admin` prefix) that are intentionally reachable
 * without an admin token. Empty by design — every admin route is protected.
 * If a route ever legitimately needs to be public, add it here EXPLICITLY
 * rather than weakening the guard. Matching is exact on the pathname.
 */
const PUBLIC_ADMIN_PATHS = new Set<string>()

function isPublicAdminPath(pathname: string): boolean {
  return PUBLIC_ADMIN_PATHS.has(pathname)
}

/**
 * Scoped plugin enforcing admin authentication on every admin route.
 *
 * `as: 'scoped'` so the hook propagates exactly one level up — to the root app
 * that mounts `adminRoutes` — without leaking onto sibling routers. It runs in
 * registration order after the admin audit plugin's start-time stash, so the
 * audit `onAfterResponse` hook still records rejected (401/403) attempts.
 */
export const adminAuthGuard = new Elysia({ name: 'admin-auth-guard' })
  .onBeforeHandle({ as: 'scoped' }, async ({ request, headers, set }) => {
    const pathname = new URL(request.url).pathname
    if (isPublicAdminPath(pathname)) return

    const token = extractBearerToken(headers as Record<string, string | undefined>)
    if (!token) {
      set.status = 401
      return { error: 'Unauthorized', details: 'Bearer token required' }
    }

    // 401-class: signature / expiry / issuer / format failures.
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

    // 403-class: token is valid but is not an admin token. TWO distinct reasons, reported
    // separately — they used to share one message, and "Admin permissions required" for what was
    // actually an audience mismatch is a genuinely misleading thing to hand someone debugging a
    // client integration.
    try {
      await validateAdminToken(token)
    } catch (error) {
      if (error instanceof AuthorizationError) {
        // Right audience, wrong roles: a GRANT problem. The user needs the role.
        logger.auth.warn('Admin guard rejected token (insufficient roles)', {
          path: pathname,
          error: error.message,
        })
        set.status = 403
        return { error: 'Forbidden', details: 'Admin role required for this deployment' }
      }
      if (error instanceof AuthenticationError) {
        // Wrong audience: a CLIENT problem. The token belongs to some other client, so no role
        // grant would help — naming the accepted clients is what actually unblocks the caller.
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
      // Unexpected non-auth error — fail closed as 401 rather than leaking through.
      logger.auth.error('Admin guard encountered unexpected error', {
        path: pathname,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      set.status = 401
      return { error: 'Unauthorized', details: 'Authentication failed' }
    }

    // Authenticated admin — fall through to the route handler.
  })
