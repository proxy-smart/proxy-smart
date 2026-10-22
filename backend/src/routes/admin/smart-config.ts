// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { smartConfigService } from '@/lib/smart-config'
import { brandBundleService } from '@/lib/brand-bundle'
import { validateAdminToken } from '@/lib/auth'
import { extractBearerToken } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import { CommonErrorResponses, SmartConfigRefreshResponse } from '@/schemas'
import { getAdminClient } from '@/lib/kc-admin-factory'
import { reconcileClientHomeUrls, reconcileResourceIndicators } from '@/lib/kc-system-provisioning'

/**
 * SMART Configuration Admin endpoints
 */
export const smartConfigAdminRoutes = new Elysia({ prefix: '/smart-config', tags: ['admin'] })
  .post('/refresh', async ({ set, headers }) => {
    // Require authentication for cache management
    const auth = extractBearerToken(headers)
    if (!auth) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    try {
      await validateAdminToken(auth)

      // Clear both SMART config and brand bundle caches
      smartConfigService.clearCache()
      brandBundleService.clearCache()
      const freshConfig = await smartConfigService.getSmartConfiguration()

      return {
        message: 'SMART configuration and brand bundle caches refreshed successfully',
        timestamp: new Date().toISOString(),
        config: freshConfig
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: SmartConfigRefreshResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Refresh SMART Configuration Cache',
      description: 'Manually refresh the cached SMART configuration and User-Access Brand Bundle from Keycloak',
      tags: ['admin', 'smart-apps'],
      security: [{ BearerAuth: [] }]
    }
  })
  .post('/reconcile-resource-indicators', async ({ set, headers }) => {
    const auth = extractBearerToken(headers)
    if (!auth) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    try {
      await validateAdminToken(auth)

      const admin = await getAdminClient()
      if (!admin) {
        set.status = 503
        return { error: 'Keycloak admin client unavailable' }
      }

      const resourceClients = await reconcileResourceIndicators(admin)
      return {
        message: 'RFC 8707 resource-indicator wiring reconciled',
        timestamp: new Date().toISOString(),
        resourceClients,
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: t.Object({
        message: t.String(),
        timestamp: t.String(),
        resourceClients: t.Array(t.Object({
          clientId: t.String(),
          resourceUrl: t.Optional(t.String()),
        })),
      }),
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Reconcile RFC 8707 resource indicators',
      description: 'Reconcile the RFC 8707 resource-indicator wiring — the resource-server clients (fhir-resource-server, mcp-resource-server), the resource-indicators client scope and its audience mappers — so SMART token exchange can bind the FHIR/MCP resource audience. Provisions or repairs a realm that lacks them. Idempotent.',
      tags: ['admin', 'smart-apps'],
      security: [{ BearerAuth: [] }],
    },
  })

  .post('/reconcile-client-home-urls', async ({ set, headers }) => {
    const auth = extractBearerToken(headers)
    if (!auth) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    try {
      await validateAdminToken(auth)

      const admin = await getAdminClient()
      if (!admin) {
        set.status = 503
        return { error: 'Keycloak admin client unavailable' }
      }

      const clients = await reconcileClientHomeUrls(admin)
      return {
        message: `Set baseUrl on ${clients.length} client(s)`,
        timestamp: new Date().toISOString(),
        clients,
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: t.Object({
        message: t.String(),
        timestamp: t.String(),
        clients: t.Array(t.Object({
          clientId: t.String(),
          baseUrl: t.String(),
        })),
      }),
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Reconcile client home URLs',
      description: "Set baseUrl on every SMART client whose baseUrl is missing or one of this proxy's own roots, from its client_uri, launch URL or redirect URIs, so Keycloak's error and page-expired screens link back to the app. A Home URL on any other host is kept. Also runs at startup. Idempotent.",
      tags: ['admin', 'smart-apps'],
      security: [{ BearerAuth: [] }],
    },
  })
