// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import { requireAdminClient } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import { ErrorResponse, SuccessResponse } from '@/schemas'
import { ClientRegistrationSettings, type ClientRegistrationSettingsType } from '@/schemas/auth/client-registration'
import { logger } from '@/lib/logger'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { configuredRealm, writeAttributeGroup } from '@/lib/runtime-config'

/**
 * Admin settings for Dynamic Client Registration
 * Controls security and policy settings for the public registration endpoint
 */

const DEFAULT_SETTINGS: ClientRegistrationSettingsType = {
  enabled: true,
  requireHttps: true,
  allowedScopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'fhirUser',
    'launch',
    'launch/patient',
    'launch/encounter',
    'patient/*.read',
    'patient/*.rs',
    'user/*.read',
    'user/*.rs',
    'online_access'
  ],
  maxClientLifetime: 365, // 1 year
  requireTermsOfService: false,
  requirePrivacyPolicy: false,
  allowPublicClients: true,
  allowConfidentialClients: true,
  allowBackendServices: false, // More restricted by default
  adminApprovalRequired: false,
  // A DCR client is an unknown third party that registered itself; the user should be asked.
  // Also what makes Keycloak honour a client's own prompt=consent.
  requireConsent: true,
  rateLimitPerMinute: 10,
  maxRedirectUris: 5,
  allowedRedirectUriPatterns: [
    'https://.*', // HTTPS only by default
    'http://localhost(:\\d+)?(/.*)?', // Allow localhost for development (with or without port)
    'http://127\\.0\\.0\\.1(:\\d+)?(/.*)?$' // Allow loopback for development (with or without port)
  ]
}

/** Settings from the realm attributes, defaults for unset keys; a failed realm read throws, so registration fails closed. */
async function getClientRegistrationSettings(admin: KcAdminClient): Promise<ClientRegistrationSettingsType> {
  const realm = await admin.realms.findOne({ realm: configuredRealm() })
  const attributes = realm?.attributes || {}

  return {
    enabled: attributes['client_registration.enabled'] !== undefined 
      ? attributes['client_registration.enabled'] === 'true' 
      : DEFAULT_SETTINGS.enabled,
    requireHttps: attributes['client_registration.require_https'] !== 'false', // Default true
    allowedScopes: attributes['client_registration.allowed_scopes']?.split(',') || DEFAULT_SETTINGS.allowedScopes,
    maxClientLifetime: parseInt(attributes['client_registration.max_client_lifetime'] || '365'),
    requireTermsOfService: attributes['client_registration.require_tos'] === 'true',
    requirePrivacyPolicy: attributes['client_registration.require_privacy_policy'] === 'true',
    allowPublicClients: attributes['client_registration.allow_public'] !== 'false',
    allowConfidentialClients: attributes['client_registration.allow_confidential'] !== 'false',
    allowBackendServices: attributes['client_registration.allow_backend_services'] === 'true',
    adminApprovalRequired: attributes['client_registration.admin_approval_required'] === 'true',
    // Default TRUE: absent attribute means an older realm that predates the setting, and the
    // safe reading there is 'ask the user', not 'skip consent'.
    requireConsent: attributes['client_registration.require_consent'] !== 'false',
    rateLimitPerMinute: parseInt(attributes['client_registration.rate_limit'] || '10'),
    maxRedirectUris: parseInt(attributes['client_registration.max_redirect_uris'] || '5'),
    allowedRedirectUriPatterns: attributes['client_registration.allowed_redirect_patterns']?.split('|') || DEFAULT_SETTINGS.allowedRedirectUriPatterns,
    notificationEmail: attributes['client_registration.notification_email']
  }
}

/** Rewrites the whole client_registration.* group, so a cleared optional setting is removed. */
async function saveClientRegistrationSettings(admin: KcAdminClient, settings: ClientRegistrationSettingsType): Promise<void> {
  await writeAttributeGroup(admin, 'client_registration.', {
    'client_registration.enabled': settings.enabled.toString(),
    'client_registration.require_https': settings.requireHttps.toString(),
    'client_registration.allowed_scopes': settings.allowedScopes.join(','),
    'client_registration.max_client_lifetime': settings.maxClientLifetime.toString(),
    'client_registration.require_tos': settings.requireTermsOfService.toString(),
    'client_registration.require_privacy_policy': settings.requirePrivacyPolicy.toString(),
    'client_registration.allow_public': settings.allowPublicClients.toString(),
    'client_registration.allow_confidential': settings.allowConfidentialClients.toString(),
    'client_registration.allow_backend_services': settings.allowBackendServices.toString(),
    'client_registration.admin_approval_required': settings.adminApprovalRequired.toString(),
    // `?? true`: the field is optional on the wire, so a caller that omits it must not crash
    // the save — and the safe reading of "unspecified" is to keep asking the user.
    'client_registration.require_consent': (settings.requireConsent ?? true).toString(),
    'client_registration.rate_limit': settings.rateLimitPerMinute.toString(),
    'client_registration.max_redirect_uris': settings.maxRedirectUris.toString(),
    'client_registration.allowed_redirect_patterns': settings.allowedRedirectUriPatterns.join('|'),
    ...(settings.notificationEmail && { 'client_registration.notification_email': settings.notificationEmail })
  })
}

export const clientRegistrationSettingsRoutes = new Elysia({ prefix: '/client-registration', tags: ['admin'] })
  .use(keycloakPlugin)

  .get('/settings', async ({ getAdmin, headers, set }) => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const settings = await getClientRegistrationSettings(admin)
      
      return settings
    } catch (error) {
      logger.admin.error('Failed to get client registration settings', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: ClientRegistrationSettings,
      401: ErrorResponse,
      403: ErrorResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'Get Dynamic Client Registration Settings',
      description: 'Get current settings for dynamic client registration',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  .put('/settings', async ({ getAdmin, body, headers, set }) => {
    try {
      // Validate regex patterns before saving — reject dangerous patterns
      if (body.allowedRedirectUriPatterns) {
        for (const pattern of body.allowedRedirectUriPatterns) {
          try {
            new RegExp(pattern)
          } catch {
            set.status = 400
            return { error: `Invalid regex pattern: ${pattern}` }
          }
          // Reject patterns with catastrophic backtracking indicators
          if (/(\.\*){3,}|(\([^)]*\+\))\+|(\([^)]*\*\))\+|(\([^)]*\+\))\*/.test(pattern)) {
            set.status = 400
            return { error: `Potentially unsafe regex pattern rejected: ${pattern}` }
          }
        }
      }

      const admin = await requireAdminClient({ getAdmin, headers })
      await saveClientRegistrationSettings(admin, body)
      
      logger.admin.info('Client registration settings updated', { settings: body })
      return { success: true, message: 'Client registration settings updated successfully' }
    } catch (error) {
      logger.admin.error('Failed to update client registration settings', { error })
      return handleAdminError(error, set)
    }
  }, {
    body: ClientRegistrationSettings,
    response: {
      200: SuccessResponse,
      400: ErrorResponse,
      401: ErrorResponse,
      403: ErrorResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'Update Dynamic Client Registration Settings',
      description: 'Update settings for dynamic client registration',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

  .post('/reset-defaults', async ({ getAdmin, headers, set }) => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      await saveClientRegistrationSettings(admin, DEFAULT_SETTINGS)
      
      logger.admin.info('Client registration settings reset to defaults')
      return { success: true, message: 'Client registration settings reset to defaults' }
    } catch (error) {
      logger.admin.error('Failed to reset client registration settings', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: SuccessResponse,
      401: ErrorResponse,
      403: ErrorResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'Reset Client Registration Settings to Defaults',
      description: 'Reset all client registration settings to their default values',
      tags: ['admin'],
      security: [{ BearerAuth: [] }]
    }
  })

// Export the settings getter for use in the registration endpoint
export { getClientRegistrationSettings }
