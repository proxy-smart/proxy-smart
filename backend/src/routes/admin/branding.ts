// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import { extractBearerToken } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import { validateToken } from '@/lib/auth'
import { BrandConfig, BrandConfigUpdateResponse, ErrorResponse, isValidUserAccessCategoryValueSetCode, type BrandConfigType } from '@/schemas'
import { getRuntimeBrandConfig, saveBrandConfig, loadRuntimeConfig, isRuntimeConfigLoaded } from '@/lib/runtime-config'
import { brandBundleService } from '@/lib/brand-bundle'
import { logger } from '@/lib/logger'

/**
 * Brand Admin Routes
 * 
 * Endpoints for managing User-Access Brand configuration (SMART App Launch 2.2.0 Section 8).
 * Settings are persisted to Keycloak realm attributes with env var fallbacks.
 */
export const brandingAdminRoutes = new Elysia({ prefix: '/branding', tags: ['admin'] })
  .use(keycloakPlugin)

  /**
   * GET /admin/branding
   * Get current brand configuration
   */
  .get('/', async ({ set, headers, getAdmin }) => {
    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Authorization header required' }
    }

    try {
      await validateToken(token)

      // Lazy-load realm attributes on first admin access
      if (!isRuntimeConfigLoaded()) {
        try {
          const admin = await getAdmin(token)
          await loadRuntimeConfig(admin)
        } catch { /* fall back to env vars */ }
      }

      const config = getRuntimeBrandConfig()

      return {
        message: 'Brand configuration retrieved',
        config,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.admin.error('Failed to get brand config', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: BrandConfigUpdateResponse,
      401: ErrorResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'Get Brand Configuration',
      description: 'Retrieve the current User-Access Brand configuration (persisted in Keycloak realm attributes)',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  /**
   * PUT /admin/branding
   * Update brand configuration (persisted to Keycloak realm attributes)
   */
  .put('/', async ({ set, headers, body, getAdmin }) => {
    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Authorization header required' }
    }

    try {
      const { category } = body
      if (typeof category !== 'string' || !isValidUserAccessCategoryValueSetCode(category)) {
        set.status = 400
        return { error: `Unknown brand category '${String(category)}'` }
      }
      const settings: BrandConfigType = { ...body, category }

      const admin = await getAdmin(token)
      await saveBrandConfig(admin, settings)

      // Clear the brand bundle cache so the next request rebuilds it
      brandBundleService.clearCache()

      return {
        message: 'Brand configuration updated',
        config: getRuntimeBrandConfig(),
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.admin.error('Failed to update brand config', { error })
      return handleAdminError(error, set)
    }
  }, {
    body: BrandConfig,
    response: {
      200: BrandConfigUpdateResponse,
      400: ErrorResponse,
      401: ErrorResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'Update Brand Configuration',
      description: 'Update User-Access Brand settings. Persisted to Keycloak realm attributes.',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })
