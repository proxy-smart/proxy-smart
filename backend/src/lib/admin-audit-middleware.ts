// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Admin Audit Middleware
 *
 * Elysia plugin that wraps every admin route with automatic audit logging.
 * Extracts actor identity from the JWT, classifies the action (create / update /
 * delete / action / read) from the HTTP method, infers the resource domain from
 * the URL path, and logs the outcome after the response is produced.
 *
 * Usage:  adminRoutes.use(adminAuditPlugin)
 */

import { Elysia } from 'elysia'
import { adminAuditLogger, type AdminAuditEvent } from './admin-audit-logger'
import { extractBearerToken } from './admin-utils'
import { validateToken } from './auth'
import { readKeycloakClaims } from './jwt-claims'
import { logger } from './logger'
import { clientIp } from './client-ip'

// Methods that mutate state — only audit these by default.
// GET requests are high-volume; we log them as 'read' only when they are
// admin-specific and would not cause noise (see filter below).
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Classify HTTP method → action tag.
 */
function classifyAction(method: string): AdminAuditEvent['action'] {
  switch (method.toUpperCase()) {
    case 'POST': return 'create'
    case 'PUT':
    case 'PATCH': return 'update'
    case 'DELETE': return 'delete'
    default: return 'read'
  }
}

/**
 * Infer resource domain and optional resource ID from the path.
 * Path format: /admin/<resource>[/<id>][/sub-resource][/<sub-id>]
 *
 * Examples:
 *   /admin/smart-apps              → { resource: 'smart-apps' }
 *   /admin/smart-apps/my-client    → { resource: 'smart-apps', resourceId: 'my-client' }
 *   /admin/healthcare-users/u1     → { resource: 'healthcare-users', resourceId: 'u1' }
 *   /admin/shutdown                → { resource: 'server', resourceId: undefined }
 */
function parseResource(path: string): { resource: string; resourceId?: string } {
  // Strip query string
  const cleanPath = path.split('?')[0]
  // Split on /admin/ to get the rest
  const afterAdmin = cleanPath.split('/admin/')[1]
  if (!afterAdmin) return { resource: 'unknown' }

  const segments = afterAdmin.split('/').filter(Boolean)
  if (segments.length === 0) return { resource: 'unknown' }

  // Special single-segment actions
  if (segments.length === 1) {
    if (segments[0] === 'shutdown' || segments[0] === 'restart') {
      return { resource: 'server' }
    }
    return { resource: segments[0] }
  }

  // Two or more segments: first is resource, second is resourceId
  return {
    resource: segments[0],
    resourceId: segments[1],
  }
}

/**
 * Elysia plugin that automatically logs all admin mutations.
 */
export const adminAuditPlugin = new Elysia({ name: 'admin-audit-plugin' })
  .derive({ as: 'scoped' }, () => ({ auditStart: performance.now() }))
  .onAfterResponse({ as: 'scoped' }, async (ctx) => {
    const { request, set, auditStart } = ctx
    const method = request.method.toUpperCase()

    // Only audit mutations (POST/PUT/PATCH/DELETE) + server-critical actions
    if (!MUTATION_METHODS.has(method)) return

    const url = new URL(request.url)
    const path = url.pathname

    // Must be an admin route
    if (!path.includes('/admin')) return

    const durationMs = auditStart ? Math.round(performance.now() - auditStart) : 0
    const statusCode = typeof set.status === 'number' ? set.status : 200
    const success = statusCode >= 200 && statusCode < 400

    // Extract actor from JWT (best-effort — don't block response if this fails)
    let actor: AdminAuditEvent['actor'] = { sub: 'unknown' }
    try {
      const headers: Record<string, string | undefined> = {}
      request.headers.forEach((value, key) => { headers[key] = value })
      const token = extractBearerToken(headers)
      if (token) {
        const claims = readKeycloakClaims(await validateToken(token))
        actor = {
          sub: claims.sub ?? 'unknown',
          username: claims.preferred_username,
          email: claims.email,
        }
      }
    } catch {
      // Token may have already been validated upstream — if extraction fails,
      // we still log the event with sub='unknown'.
    }

    const { resource, resourceId } = parseResource(path)
    const action = classifyAction(method)

    const ipAddress = clientIp(request, { server: ctx.server })

    adminAuditLogger.log({
      actor,
      method,
      path,
      action,
      resource,
      resourceId,
      statusCode,
      success,
      durationMs,
      ipAddress,
    }).catch(err => {
      logger.admin.error('Audit log write failed', { error: err })
    })
  })
