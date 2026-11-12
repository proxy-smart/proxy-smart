// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { logger } from '@/lib/logger'
import { extractBearerToken } from '@/lib/admin-utils'
import { validateAdminToken } from '@/lib/auth'
import { adminAuthGuard } from '@/lib/admin-auth-guard'
import { ErrorResponse, ServerOperationResponse } from '@/schemas'
import { smartAppsRoutes } from './smart-apps'
import { smartAppMapperRoutes } from './smart-app-mappers'
import { healthcareUsersRoutes } from './healthcare-users'
import { profileAdminRoutes } from './profile'
import { rolesRoutes } from './roles'
import { identityProvidersRoutes } from './identity-providers'
import { identityProviderMapperRoutes } from './identity-provider-mappers'
import { smartConfigAdminRoutes } from './smart-config'
import { clientRegistrationSettingsRoutes } from './client-registration-settings'
import { keycloakConfigRoutes } from './keycloak-config'
import { mcpEndpointAdminRoutes } from './mcp-endpoint'
import { consentAdminRoutes } from './consent'
import { smartAccessControlAdminRoutes } from './smart-access-control'
import { userFederationRoutes } from './user-federation'
import { userFederationMapperRoutes } from './user-federation-mappers'
import { brandingAdminRoutes } from './branding'
import { scopeMappersRoutes } from './scope-mappers'
import { smartScopesRoutes } from './smart-scopes'
import { organizationsRoutes } from './organizations'
import { appStoreAdminRoutes } from './app-store'
import { clientPoliciesRoutes } from './client-policies'
import { dicomServersAdminRoutes } from '../dicom-servers'
import { authFlowsRoutes } from './auth-flows'
import { scopeSetsAdminRoutes } from './scope-sets'
import { fhirServersAdminRoutes } from '../fhir-servers'
import { monitoringEndpointRoutes } from '../monitoring'
import { fhirCapabilitiesRoutes } from '../fhir-capabilities'
import { adminStatusRoutes } from '../status'
import { initializeToolRegistry } from '@/lib/ai/tool-registry'
import { adminAuditPlugin } from '@/lib/admin-audit-middleware'

export const adminRoutes = new Elysia({ prefix: '/admin' })
  // First, so requests the auth guard rejects (401/403) are still audited.
  .use(adminAuditPlugin)
  // The real enforcement; `.guard()` below only adds OpenAPI security metadata.
  .use(adminAuthGuard)
  .guard({
    detail: {
      security: [{ BearerAuth: [] }]
    }
  })
  .post('/shutdown', async ({ set, headers }) => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Unauthorized', details: 'Bearer token required' } }
      await validateAdminToken(token)
      logger.server.info('🛑 Shutdown requested via admin API')
      setTimeout(() => {
        logger.server.info('🛑 Shutting down server...')
        process.exit(0)
      }, 100)
      return { success: true, message: 'Server shutdown initiated', timestamp: new Date().toISOString() }
    } catch (error) {
      set.status = 500
      return { error: 'Failed to shutdown server', details: error instanceof Error ? error.message : 'An unexpected error occurred' }
    }
  }, {
    response: {
      200: ServerOperationResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'Shutdown Server',
      description: 'Gracefully shutdown the SMART on FHIR server (admin only)',
      tags: ['admin']
    }
  })
  .post('/restart', async ({ set, headers }) => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Unauthorized', details: 'Bearer token required' } }
      await validateAdminToken(token)
      logger.server.info('🔄 Restart requested via admin API')
      setTimeout(() => {
        logger.server.info('🔄 Restarting server...')
        process.exit(1)
      }, 100)
      return { success: true, message: 'Server restart initiated', timestamp: new Date().toISOString() }
    } catch (error) {
      set.status = 500
      return { error: 'Failed to restart server', details: error instanceof Error ? error.message : 'An unexpected error occurred' }
    }
  }, {
    response: {
      200: ServerOperationResponse,
      500: ErrorResponse
    },
    detail: {
      summary: 'Restart Server',
      description: 'Restart the SMART on FHIR server (admin only)',
      tags: ['admin']
    }
  })
  .use(smartAppsRoutes)
  .use(smartAppMapperRoutes)
  .use(profileAdminRoutes)
  .use(healthcareUsersRoutes)
  .use(rolesRoutes)
  .use(identityProvidersRoutes)
  .use(identityProviderMapperRoutes)
  .use(smartConfigAdminRoutes)
  .use(brandingAdminRoutes)
  .use(clientRegistrationSettingsRoutes)
  .use(keycloakConfigRoutes)
  .use(mcpEndpointAdminRoutes)
  .use(consentAdminRoutes)
  .use(smartAccessControlAdminRoutes)
  .use(userFederationRoutes)
  .use(userFederationMapperRoutes)
  .use(scopeMappersRoutes)
  .use(smartScopesRoutes)
  .use(organizationsRoutes)
  .use(appStoreAdminRoutes)
  .use(clientPoliciesRoutes)
  .use(dicomServersAdminRoutes)
  .use(authFlowsRoutes)
  .use(scopeSetsAdminRoutes)
  // Mounted here so it inherits the guard and audit log and the tool registry sees it.
  .use(fhirServersAdminRoutes)
  // The SSE streams are mounted separately.
  .use(monitoringEndpointRoutes)
  .use(fhirCapabilitiesRoutes)
  .use(adminStatusRoutes)

initializeToolRegistry(adminRoutes, {
  prefixes: [
    '/admin/',
  ]
})
