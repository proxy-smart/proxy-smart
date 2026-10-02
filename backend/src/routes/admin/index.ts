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
import { initializeToolRegistry } from '@/lib/ai/tool-registry'
import { adminAuditPlugin } from '@/lib/admin-audit-middleware'

/**
 * Admin routes aggregator - combines all admin functionality
 */
export const adminRoutes = new Elysia({ prefix: '/admin' })
  // Audit middleware — logs every admin mutation with actor identity.
  // Registered first so its onBeforeHandle stashes the audit start-time and its
  // onAfterResponse still records requests the auth guard rejects (401/403).
  .use(adminAuditPlugin)
  // Structural authentication: enforce a valid Keycloak admin token on EVERY
  // admin route before any handler runs. This is the real enforcement; the
  // `.guard()` below only contributes OpenAPI security metadata.
  .use(adminAuthGuard)
  // OpenAPI security metadata for the protected routes (documentation only).
  .guard({
    detail: {
      security: [{ BearerAuth: [] }]
    }
  })
  // Operational: Shutdown server
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
  // Operational: Restart server
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
  // Per-client protocol mappers (what a SMART app's tokens actually contain)
  .use(smartAppMapperRoutes)
  .use(profileAdminRoutes)
  .use(healthcareUsersRoutes)
  .use(rolesRoutes)
  .use(identityProvidersRoutes)
  // Brokered-login claim mapping (fhirUser imports for federated users)
  .use(identityProviderMapperRoutes)
  .use(smartConfigAdminRoutes)
  .use(brandingAdminRoutes)
  .use(clientRegistrationSettingsRoutes)
  .use(keycloakConfigRoutes)
  // MCP endpoint (built-in Streamable HTTP MCP server) management
  .use(mcpEndpointAdminRoutes)
  // Consent enforcement management
  .use(consentAdminRoutes)
  // SMART access control (scope enforcement, role-based filtering)
  .use(smartAccessControlAdminRoutes)
  // LDAP User Federation management
  .use(userFederationRoutes)
  // LDAP mapper management (which directory attributes reach the Keycloak user)
  .use(userFederationMapperRoutes)
  // SMART scope protocol mapper management
  .use(scopeMappersRoutes)
  // SMART client scope CRUD management
  .use(smartScopesRoutes)
  // Keycloak Organizations management
  .use(organizationsRoutes)
  // App Store visibility management
  .use(appStoreAdminRoutes)
  // Keycloak Client Policies & CIMD management
  .use(clientPoliciesRoutes)
  // DICOM/PACS server management
  .use(dicomServersAdminRoutes)
  // Authentication flow management (client authenticators, federated-jwt)
  .use(authFlowsRoutes)
  // Scope Sets — reusable named scope collections
  .use(scopeSetsAdminRoutes)
  // FHIR server administration. Here rather than alongside public discovery so it inherits
  // adminAuthGuard and the audit log, and so the tool registry below can see it at all.
  .use(fhirServersAdminRoutes)

// Initialize the tool registry once at startup
initializeToolRegistry(adminRoutes, {
  prefixes: [
    '/admin/', // Admin routes (healthcare users, SMART apps, FHIR servers, etc.)
  ]
})
