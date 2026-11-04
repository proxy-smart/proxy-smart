// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import { requireAdminClient } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import { CommonErrorResponses, ScopeMapperStatusResponse, ScopeMapperFixResponse, SuccessResponse } from '@/schemas'
import { getSmartMapperStatus, ensureAllSmartMappers } from '@/lib/smart-scope-mappers'
import { logger } from '@/lib/logger'

export const scopeMappersRoutes = new Elysia({ prefix: '/scope-mappers', tags: ['admin'] })
  .use(keycloakPlugin)

  .get('/', async ({ set, headers, getAdmin }) => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const status = await getSmartMapperStatus(admin)

      return {
        status,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.admin.error('Failed to get scope mapper status', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: ScopeMapperStatusResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get SMART Scope Mapper Status',
      description: 'Returns the health status of all SMART protocol mappers across Keycloak client scopes',
      tags: ['admin', 'smart-apps'],
      security: [{ BearerAuth: [] }]
    }
  })

  .post('/fix', async ({ set, headers, getAdmin }) => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const result = await ensureAllSmartMappers(admin)

      logger.admin.info('SMART scope mappers fix completed', result)

      return {
        message: result.errors.length > 0
          ? `Created ${result.created} mapper(s); ${result.errors.length} could not be reconciled`
          : result.created > 0
            ? `Created ${result.created} missing mapper(s) across ${result.scanned} scope(s)`
            : 'All SMART protocol mappers are already configured',
        scanned: result.scanned,
        created: result.created,
        errors: result.errors,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.admin.error('Failed to fix scope mappers', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: ScopeMapperFixResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Fix Missing SMART Protocol Mappers',
      description: 'Auto-provision all missing SMART protocol mappers on Keycloak client scopes (idempotent)',
      tags: ['admin', 'smart-apps'],
      security: [{ BearerAuth: [] }]
    }
  })

  .delete('/:scopeId/:mapperId', async ({ set, headers, getAdmin, params }) => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })

      await admin.clientScopes.delProtocolMapper({
        id: params.scopeId,
        mapperId: params.mapperId
      })

      logger.admin.info('Deleted protocol mapper', { scopeId: params.scopeId, mapperId: params.mapperId })

      return {
        success: true,
        message: 'Protocol mapper deleted'
      }
    } catch (error) {
      logger.admin.error('Failed to delete protocol mapper', { error, ...params })
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      scopeId: t.String({ description: 'Keycloak client scope ID' }),
      mapperId: t.String({ description: 'Protocol mapper ID to delete' })
    }),
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Delete Protocol Mapper',
      description: 'Remove a specific protocol mapper from a Keycloak client scope',
      tags: ['admin', 'smart-apps'],
      security: [{ BearerAuth: [] }]
    }
  })
