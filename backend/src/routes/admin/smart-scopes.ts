// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  CommonErrorResponses,
  SmartScopeResponse,
  SmartScopeListResponse,
  CreateSmartScopeRequest,
  CreateSmartScopeBatchRequest,
  SmartScopeBatchResponse,
  SuccessResponse,
  type SmartScopeResponseType,
  type SmartScopeListResponseType,
  type SmartScopeBatchResponseType,
  type ErrorResponseType,
  type SuccessResponseType,
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { requireAdminClient } from '@/lib/admin-utils'
import { logger } from '@/lib/logger'
import { isSMARTScope, SMART_LAUNCH_SCOPES } from '@/lib/smart-client-enrichment'

/**
 * SMART Client Scope management endpoints.
 * List, create, and delete Keycloak client scopes used for SMART authorization.
 */
export const smartScopesRoutes = new Elysia({ prefix: '/smart-scopes', tags: ['admin'] })
  .use(keycloakPlugin)

  /**
   * GET /admin/smart-scopes
   * List all client scopes, optionally filtered to SMART-only
   */
  .get('/', async ({ getAdmin, headers, set, query }): Promise<SmartScopeListResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const allScopes = await admin.clientScopes.find()

      let scopes = allScopes.flatMap(({ id, name, description, protocol, attributes }) => id && name ? [{
        id,
        name,
        description: description || undefined,
        protocol: protocol || 'openid-connect',
        attributes: attributes ? Object.fromEntries(
          Object.entries(attributes).map(([k, v]) => [k, Array.isArray(v) ? v[0] || '' : String(v)])
        ) : undefined,
      }] : [])

      // Filter to SMART scopes only if requested
      if (query.smartOnly === 'true') {
        scopes = scopes.filter(s => isSMARTScope(s.name))
      }

      // Sort: launch scopes first, then by name
      scopes.sort((a, b) => {
        const aIsLaunch = SMART_LAUNCH_SCOPES.includes(a.name)
        const bIsLaunch = SMART_LAUNCH_SCOPES.includes(b.name)
        if (aIsLaunch && !bIsLaunch) return -1
        if (!aIsLaunch && bIsLaunch) return 1
        return a.name.localeCompare(b.name)
      })

      return {
        scopes,
        total: scopes.length,
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    query: t.Object({
      smartOnly: t.Optional(t.String({ description: 'Filter to SMART scopes only (true/false)' })),
    }),
    response: {
      200: SmartScopeListResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'List SMART Scopes',
      description: 'List all Keycloak client scopes. Use ?smartOnly=true to filter to SMART on FHIR scopes.',
      tags: ['admin', 'smart-scopes'],
      security: [{ BearerAuth: [] }],
    },
  })

  /**
   * POST /admin/smart-scopes
   * Create a single new SMART client scope in Keycloak
   */
  .post('/', async ({ getAdmin, body, headers, set }): Promise<SmartScopeResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })

      // Check if scope already exists
      const existing = await admin.clientScopes.find()
      if (existing.find(s => s.name === body.name)) {
        set.status = 409
        return { error: `Scope '${body.name}' already exists` }
      }

      // Validate SMART scope format
      if (!isSMARTScope(body.name)) {
        logger.admin.warn('Creating non-SMART scope via smart-scopes endpoint', { name: body.name })
      }

      // Create the client scope
      const created = await admin.clientScopes.create({
        name: body.name,
        description: body.description || `SMART scope: ${body.name}`,
        protocol: 'openid-connect',
        attributes: {
          'include.in.token.scope': 'true',
          'display.on.consent.screen': 'true',
          'consent.screen.text': body.description || body.name,
        },
      })

      logger.admin.info('Created SMART client scope', { name: body.name, id: created.id })

      return {
        id: created.id,
        name: body.name,
        description: body.description || `SMART scope: ${body.name}`,
        protocol: 'openid-connect',
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: CreateSmartScopeRequest,
    response: {
      200: SmartScopeResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Create SMART Scope',
      description: 'Create a new SMART client scope in Keycloak (e.g. user/Claim.cud, patient/Observation.rs)',
      tags: ['admin', 'smart-scopes'],
      security: [{ BearerAuth: [] }],
    },
  })

  /**
   * POST /admin/smart-scopes/batch
   * Create multiple SMART scopes at once (idempotent — skips existing)
   */
  .post('/batch', async ({ getAdmin, body, headers, set }): Promise<SmartScopeBatchResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const existingScopes = await admin.clientScopes.find()
      const existingNames = new Set(existingScopes.map(s => s.name))

      const created: SmartScopeResponseType[] = []
      const alreadyExisting: string[] = []
      const errors: { name: string; error: string }[] = []

      for (const scope of body.scopes) {
        if (existingNames.has(scope.name)) {
          alreadyExisting.push(scope.name)
          continue
        }

        try {
          const result = await admin.clientScopes.create({
            name: scope.name,
            description: scope.description || `SMART scope: ${scope.name}`,
            protocol: 'openid-connect',
            attributes: {
              'include.in.token.scope': 'true',
              'display.on.consent.screen': 'true',
              'consent.screen.text': scope.description || scope.name,
            },
          })

          created.push({
            id: result.id,
            name: scope.name,
            description: scope.description || `SMART scope: ${scope.name}`,
            protocol: 'openid-connect',
          })

          logger.admin.info('Created SMART scope (batch)', { name: scope.name, id: result.id })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push({ name: scope.name, error: msg })
          logger.admin.warn('Failed to create scope in batch', { name: scope.name, error: msg })
        }
      }

      return {
        created,
        existing: alreadyExisting,
        errors,
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: CreateSmartScopeBatchRequest,
    response: {
      200: SmartScopeBatchResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Batch Create SMART Scopes',
      description: 'Create multiple SMART scopes at once. Existing scopes are skipped (idempotent).',
      tags: ['admin', 'smart-scopes'],
      security: [{ BearerAuth: [] }],
    },
  })

  /**
   * DELETE /admin/smart-scopes/:scopeId
   * Delete a client scope from Keycloak
   */
  .delete('/:scopeId', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })

      // Verify the scope exists before deleting
      const scope = await admin.clientScopes.findOne({ id: params.scopeId })
      if (!scope) {
        set.status = 404
        return { error: `Scope with ID '${params.scopeId}' not found` }
      }

      await admin.clientScopes.del({ id: params.scopeId })

      logger.admin.info('Deleted SMART client scope', { id: params.scopeId, name: scope.name })

      return {
        success: true,
        message: `Scope '${scope.name}' deleted successfully`,
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      scopeId: t.String({ description: 'Keycloak client scope ID' }),
    }),
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Delete SMART Scope',
      description: 'Delete a SMART client scope from Keycloak by its ID',
      tags: ['admin', 'smart-scopes'],
      security: [{ BearerAuth: [] }],
    },
  })
