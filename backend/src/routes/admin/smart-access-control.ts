// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { SmartAccessControlConfig, SmartAccessControlConfigUpdateResponse } from '@/schemas'
import { getRuntimeAccessControlConfig, saveAccessControlConfig } from '@/lib/runtime-config'
import { runtimeSettingsRoutes } from '@/lib/runtime-settings-routes'

export const smartAccessControlAdminRoutes = new Elysia({ prefix: '/smart-access-control', tags: ['admin'] })
  .use(runtimeSettingsRoutes({
    path: '/config',
    label: 'Access control configuration',
    body: SmartAccessControlConfig,
    response: SmartAccessControlConfigUpdateResponse,
    read: getRuntimeAccessControlConfig,
    save: saveAccessControlConfig,
    docs: {
      get: {
        summary: 'Get SMART Access Control Configuration',
        description: 'Retrieve scope enforcement, role-based filtering, and patient-scoped resource settings'
      },
      put: {
        summary: 'Update SMART Access Control Configuration',
        description: 'Update scope enforcement, role-based filtering, and patient-scoped resource settings (persisted in Keycloak realm attributes)'
      }
    }
  }))
