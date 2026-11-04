// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Audits every admin mutation (POST/PUT/PATCH/DELETE) after the response; reads are not logged. */

import { Elysia } from 'elysia'
import { adminAuditLogger, type AdminAuditEvent } from './admin-audit-logger'
import { extractBearerToken } from './admin-utils'
import { validateToken } from './auth'
import { readKeycloakClaims } from './jwt-claims'
import { logger } from './logger'
import { clientIp } from './client-ip'

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const SERVER_RESOURCE = 'server'

function classifyAction(method: string, resource: string): AdminAuditEvent['action'] {
  switch (method.toUpperCase()) {
    case 'POST': return resource === SERVER_RESOURCE ? 'action' : 'create'
    case 'PUT':
    case 'PATCH': return 'update'
    case 'DELETE': return 'delete'
    default: return 'read'
  }
}

/** `/admin/<resource>[/<id>]/...`; `/admin/shutdown` and `/admin/restart` map to the server resource. */
function parseResource(path: string): { resource: string; resourceId?: string } {
  const afterAdmin = path.split('?')[0].split('/admin/')[1]
  if (!afterAdmin) return { resource: 'unknown' }

  const segments = afterAdmin.split('/').filter(Boolean)
  if (segments.length === 0) return { resource: 'unknown' }

  if (segments.length === 1) {
    if (segments[0] === 'shutdown' || segments[0] === 'restart') {
      return { resource: SERVER_RESOURCE }
    }
    return { resource: segments[0] }
  }

  return {
    resource: segments[0],
    resourceId: segments[1],
  }
}

export const adminAuditPlugin = new Elysia({ name: 'admin-audit-plugin' })
  .derive({ as: 'scoped' }, () => ({ auditStart: performance.now() }))
  .onAfterResponse({ as: 'scoped' }, async (ctx) => {
    const { request, set, auditStart } = ctx
    const method = request.method.toUpperCase()

    if (!MUTATION_METHODS.has(method)) return

    const url = new URL(request.url)
    const path = url.pathname

    if (!path.includes('/admin')) return

    const durationMs = auditStart ? Math.round(performance.now() - auditStart) : 0
    const statusCode = typeof set.status === 'number' ? set.status : 200
    const success = statusCode >= 200 && statusCode < 400

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
      // An unverifiable token still gets its event, attributed to 'unknown'.
    }

    const { resource, resourceId } = parseResource(path)
    const action = classifyAction(method, resource)

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
