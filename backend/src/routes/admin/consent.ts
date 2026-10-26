// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import { validateToken, validateAdminToken } from '@/lib/auth'
import { extractBearerToken } from '@/lib/admin-utils'
import { getConsentCacheStats, consentCache } from '@/lib/consent'
import { invalidateRecordCustody } from '@/lib/consent/record-custody'
import {
  CommonErrorResponses,
  ConsentConfig,
  ConsentCacheStats,
  IalConfigSchema,
  ErrorResponse,
  ConsentConfigUpdateResponse,
  IalConfigUpdateResponse,
  ConsentCacheInvalidateRequest,
  ConsentCacheInvalidateResponse,
} from '@/schemas'
import { logger } from '@/lib/logger'
import { getRuntimeConsentConfig, getRuntimeIalConfig, saveConsentConfig, saveIalConfig, loadRuntimeConfig, isRuntimeConfigLoaded } from '@/lib/runtime-config'

/**
 * Consent Admin Routes
 * 
 * Endpoints for managing consent enforcement configuration and cache.
 */
export const consentAdminRoutes = new Elysia({ prefix: '/consent', tags: ['admin'] })
  .use(keycloakPlugin)

  /**
   * GET /admin/consent/config
   * Get current consent enforcement configuration (runtime = realm attrs + env fallback)
   */
  .get('/config', async ({ set, headers, getAdmin }) => {
    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Authentication required' }
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

      const config = getRuntimeConsentConfig()
      
      return {
        message: 'Consent configuration retrieved',
        config,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.consent.error('Failed to get consent config', { error })
      set.status = 500
      return { error: 'Failed to get consent configuration', details: error instanceof Error ? error.message : String(error) }
    }
  }, {
    response: {
      200: ConsentConfigUpdateResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Consent Configuration',
      description: 'Retrieve the current consent enforcement configuration (persisted in Keycloak realm attributes)',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  /**
   * PUT /admin/consent/config
   * Update consent enforcement configuration (persisted to Keycloak realm attributes)
   */
  .put('/config', async ({ set, headers, body, getAdmin }) => {
    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Authorization header required' }
    }

    try {
      const admin = await getAdmin(token)
      await saveConsentConfig(admin, body)

      return {
        message: 'Consent configuration updated',
        config: getRuntimeConsentConfig(),
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.consent.error('Failed to update consent config', { error })
      set.status = 500
      return { error: 'Failed to update consent configuration', details: error instanceof Error ? error.message : String(error) }
    }
  }, {
    body: ConsentConfig,
    response: {
      200: ConsentConfigUpdateResponse,
      401: ErrorResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'Update Consent Configuration',
      description: 'Update consent enforcement settings. Persisted to Keycloak realm attributes.',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  /**
   * GET /admin/consent/ial
   * Get current IAL configuration
   */
  .get('/ial', async ({ set, headers, getAdmin }) => {
    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Authentication required' }
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

      const config = getRuntimeIalConfig()
      
      return {
        message: 'IAL configuration retrieved',
        config,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.consent.error('Failed to get IAL config', { error })
      set.status = 500
      return { error: 'Failed to get IAL configuration', details: error instanceof Error ? error.message : String(error) }
    }
  }, {
    response: {
      200: IalConfigUpdateResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get IAL Configuration',
      description: 'Retrieve the current Identity Assurance Level (IAL) configuration',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  /**
   * PUT /admin/consent/ial
   * Update IAL configuration (persisted to Keycloak realm attributes)
   */
  .put('/ial', async ({ set, headers, body, getAdmin }) => {
    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Authorization header required' }
    }

    try {
      const admin = await getAdmin(token)
      await saveIalConfig(admin, body)

      return {
        message: 'IAL configuration updated',
        config: getRuntimeIalConfig(),
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.consent.error('Failed to update IAL config', { error })
      set.status = 500
      return { error: 'Failed to update IAL configuration', details: error instanceof Error ? error.message : String(error) }
    }
  }, {
    body: IalConfigSchema,
    response: {
      200: IalConfigUpdateResponse,
      401: ErrorResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'Update IAL Configuration',
      description: 'Update Identity Assurance Level settings. Persisted to Keycloak realm attributes.',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  /**
   * GET /admin/consent/cache/stats
   * Get consent cache statistics
   */
  .get('/cache/stats', async ({ set, headers }) => {
    const auth = extractBearerToken(headers)
    if (!auth) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    try {
      await validateAdminToken(auth)
      const stats = getConsentCacheStats()
      
      return stats
    } catch (error) {
      logger.consent.error('Failed to get cache stats', { error })
      set.status = 500
      return { error: 'Failed to get consent cache statistics', details: error instanceof Error ? error.message : String(error) }
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
    const auth = extractBearerToken(headers)
    if (!auth) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    try {
      await validateAdminToken(auth)
      
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
      set.status = 500
      return { error: 'Failed to invalidate consent cache', details: error instanceof Error ? error.message : String(error) }
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
    const auth = extractBearerToken(headers)
    if (!auth) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    try {
      await validateAdminToken(auth)
      
      const entriesCleaned = consentCache.cleanup()
      logger.consent.info('Consent cache cleanup via admin API', { entriesCleaned })
      
      return {
        message: 'Consent cache cleanup completed',
        entriesInvalidated: entriesCleaned,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.consent.error('Failed to cleanup consent cache', { error })
      set.status = 500
      return { error: 'Failed to cleanup consent cache', details: error instanceof Error ? error.message : String(error) }
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

  /**
   * POST /admin/consent/webhook
   * Webhook endpoint for external consent updates (e.g., from FHIR server)
   */
  .post('/webhook', async ({ set, headers, body }) => {
    // Webhook can use API key or Bearer token
    const auth = extractBearerToken(headers)
    // Note: API key support (x-api-key) reserved for future implementation
    
    // For now, require Bearer token (could add API key support later)
    if (!auth) {
      set.status = 401
      return { error: 'Authentication required' }
    }

    try {
      await validateAdminToken(auth)
      
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
      set.status = 500
      return { error: 'Failed to process consent webhook', details: error instanceof Error ? error.message : String(error) }
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
