// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { BrandConfig, BrandConfigUpdateResponse } from '@/schemas'
import { getRuntimeBrandConfig, saveBrandConfig } from '@/lib/runtime-config'
import { brandBundleService } from '@/lib/brand-bundle'
import { runtimeSettingsRoutes } from '@/lib/runtime-settings-routes'

/** User-Access Brand configuration (SMART App Launch 2.2.0 Section 8). */
export const brandingAdminRoutes = new Elysia({ prefix: '/branding', tags: ['admin'] })
  .use(runtimeSettingsRoutes({
    path: '/',
    label: 'Brand configuration',
    body: BrandConfig,
    response: BrandConfigUpdateResponse,
    read: getRuntimeBrandConfig,
    save: async (admin, settings) => {
      await saveBrandConfig(admin, settings)
      brandBundleService.clearCache()
    },
    docs: {
      get: {
        summary: 'Get Brand Configuration',
        description: 'Retrieve the current User-Access Brand configuration (persisted in Keycloak realm attributes)'
      },
      put: {
        summary: 'Update Brand Configuration',
        description: 'Update User-Access Brand settings. Persisted to Keycloak realm attributes.'
      }
    }
  }))
