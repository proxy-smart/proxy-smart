// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { validateAdminToken } from '@/lib/auth'
import { requireBearerToken } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import { getConsentCacheStats, consentCache } from '@/lib/consent'
import { invalidateRecordCustody } from '@/lib/consent/record-custody'
import {
  CommonErrorResponses,
  ConsentConfig,
  ConsentCacheStats,
  IalConfigSchema,
  ConsentConfigUpdateResponse,
  IalConfigUpdateResponse,
  ConsentCacheInvalidateRequest,
  ConsentCacheInvalidateResponse,
  ConsentR4MigrationRequest,
  ConsentR4MigrationResponse,
} from '@/schemas'
import { getAllServers, getServerInfoByName } from '@/lib/fhir-server-store'
import { migrateConsentProvisions } from '@/lib/consent/r4-migration'
import { createFhirTarget } from '@/lib/fhir-request-pipeline'
import { logger } from '@/lib/logger'
import { getRuntimeConsentConfig, getRuntimeIalConfig, saveConsentConfig, saveIalConfig } from '@/lib/runtime-config'
import { runtimeSettingsRoutes } from '@/lib/runtime-settings-routes'

export const consentAdminRoutes = new Elysia({ prefix: '/consent', tags: ['admin'] })
  .use(runtimeSettingsRoutes({
    path: '/config',
    label: 'Consent configuration',
    body: ConsentConfig,
    response: ConsentConfigUpdateResponse,
    read: getRuntimeConsentConfig,
    save: saveConsentConfig,
    docs: {
      get: {
        summary: 'Get Consent Configuration',
        description: 'Retrieve the current consent enforcement configuration (persisted in Keycloak realm attributes)'
      },
      put: {
        summary: 'Update Consent Configuration',
        description: 'Update consent enforcement settings. Persisted to Keycloak realm attributes.'
      }
    }
  }))

  .use(runtimeSettingsRoutes({
    path: '/ial',
    label: 'IAL configuration',
    body: IalConfigSchema,
    response: IalConfigUpdateResponse,
    read: getRuntimeIalConfig,
    save: saveIalConfig,
    docs: {
      get: {
        summary: 'Get IAL Configuration',
        description: 'Retrieve the current Identity Assurance Level (IAL) configuration'
      },
      put: {
        summary: 'Update IAL Configuration',
        description: 'Update Identity Assurance Level settings. Persisted to Keycloak realm attributes.'
      }
    }
  }))

  /**
   * GET /admin/consent/cache/stats
   * Get consent cache statistics
   */
  .get('/cache/stats', async ({ set, headers }) => {
    try {
      await validateAdminToken(requireBearerToken(headers))
      const stats = getConsentCacheStats()
      
      return stats
    } catch (error) {
      logger.consent.error('Failed to get cache stats', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: ConsentCacheStats,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Consent Cache Statistics',
      description: 'Retrieve statistics about the consent cache including entry count and TTLs',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  /**
   * POST /admin/consent/cache/invalidate
   * Invalidate consent cache entries
   */
  .post('/cache/invalidate', async ({ set, headers, body }) => {
    try {
      await validateAdminToken(requireBearerToken(headers))
      
      let entriesInvalidated = 0
      
      if (body?.all) {
        // Clear entire cache
        const stats = getConsentCacheStats()
        entriesInvalidated = stats.size
        consentCache.clear()
        invalidateRecordCustody()
        logger.consent.info('Consent cache cleared via admin API', { entriesInvalidated })
      } else if (body?.patientId) {
        // Invalidate specific patient
        entriesInvalidated = consentCache.invalidatePatient(body.patientId, body.serverName)
        invalidateRecordCustody(body.patientId)
        logger.consent.info('Patient consent cache invalidated via admin API', { 
          patientId: body.patientId, 
          serverName: body.serverName,
          entriesInvalidated 
        })
      } else if (body?.serverName) {
        // Invalidate specific server
        entriesInvalidated = consentCache.invalidateServer(body.serverName)
        invalidateRecordCustody()
        logger.consent.info('Server consent cache invalidated via admin API', { 
          serverName: body.serverName,
          entriesInvalidated 
        })
      } else {
        set.status = 400
        return { error: 'Must specify patientId, serverName, or all=true' }
      }
      
      return {
        message: 'Consent cache invalidated successfully',
        entriesInvalidated,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.consent.error('Failed to invalidate consent cache', { error })
      return handleAdminError(error, set)
    }
  }, {
    body: ConsentCacheInvalidateRequest,
    response: {
      200: ConsentCacheInvalidateResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Invalidate Consent Cache',
      description: 'Invalidate consent cache entries. Use when Consent resources are updated externally.',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  /**
   * POST /admin/consent/cache/cleanup
   * Clean up expired cache entries
   */
  .post('/cache/cleanup', async ({ set, headers }) => {
    try {
      await validateAdminToken(requireBearerToken(headers))
      
      const entriesCleaned = consentCache.cleanup()
      logger.consent.info('Consent cache cleanup via admin API', { entriesCleaned })
      
      return {
        message: 'Consent cache cleanup completed',
        entriesInvalidated: entriesCleaned,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.consent.error('Failed to cleanup consent cache', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: ConsentCacheInvalidateResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Cleanup Expired Consent Cache Entries',
      description: 'Remove expired entries from the consent cache',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  .post('/r4-migration', async ({ set, headers, body }) => {
    try {
      await validateAdminToken(requireBearerToken(headers))
      const server = body?.serverName ? await getServerInfoByName(body.serverName) : (await getAllServers())[0]
      if (!server) {
        set.status = 404
        return { error: body?.serverName ? `FHIR server ${body.serverName} not found` : 'No FHIR server is configured' }
      }
      const { upstreamFetch } = await createFhirTarget(server, server.name, server.metadata.fhirVersion)
      const result = await migrateConsentProvisions({ serverUrl: server.url, apply: body?.apply === true, upstreamFetch })
      return { server: server.name, ...result }
    } catch (error) {
      logger.consent.error('Consent R4 migration failed', { error })
      return handleAdminError(error, set)
    }
  }, {
    body: ConsentR4MigrationRequest,
    response: {
      200: ConsentR4MigrationResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Migrate Consents to the R4 Rule Shape',
      description: 'Find stored Consents whose root provision carries a type and, with apply=true, rewrite them so the root keeps the conditions and a nested rule states permit or deny. Decisions are unchanged. Without apply this is a dry run.',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  /**
   * POST /admin/consent/webhook
   * Webhook endpoint for external consent updates (e.g., from FHIR server)
   */
  .post('/webhook', async ({ set, headers, body }) => {
    try {
      await validateAdminToken(requireBearerToken(headers))
      
      // Extract patient ID from webhook payload
      // Supports FHIR subscription notification format
      const patientId = body?.patientId || 
                       body?.resource?.patient?.reference?.replace('Patient/', '') ||
                       body?.focus?.reference?.replace('Patient/', '')
      
      if (!patientId) {
        set.status = 400
        return { error: 'Could not determine patientId from webhook payload' }
      }
      
      // Invalidate cache for this patient
      const entriesInvalidated = consentCache.invalidatePatient(patientId)
      invalidateRecordCustody(patientId)
      
      logger.consent.info('Consent webhook received', { 
        patientId, 
        entriesInvalidated,
        eventType: body?.type || 'unknown'
      })
      
      return {
        message: 'Consent cache invalidated for patient',
        entriesInvalidated,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.consent.error('Failed to process consent webhook', { error })
      return handleAdminError(error, set)
    }
  }, {
    body: t.Object({
      patientId: t.Optional(t.String()),
      type: t.Optional(t.String()),
      resource: t.Optional(t.Object({
        patient: t.Optional(t.Object({
          reference: t.Optional(t.String())
        }))
      })),
      focus: t.Optional(t.Object({
        reference: t.Optional(t.String())
      }))
    }),
    response: {
      200: ConsentCacheInvalidateResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Consent Update Webhook',
      description: 'Webhook endpoint to receive notifications when Consent resources are updated. Automatically invalidates the cache for the affected patient.',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })