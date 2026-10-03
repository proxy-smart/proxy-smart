// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import { validateToken, type KeycloakJwtPayload } from './auth'
import { logger } from './logger'
import { AuthenticationError, AuthorizationError, ConfigurationError } from './admin-utils'
import { hasAdminAccess, KEYCLOAK_REALM_MANAGEMENT_CLIENT, type AdminAccess } from './admin-roles'
import { config } from '../config'

/**
 * Plugin that adds Keycloak admin client decorator.
 *
 * Uses the caller's Bearer token so Keycloak RBAC applies directly.
 * The user's fine-grained permissions (manage-users, manage-clients, etc.)
 * are enforced by Keycloak on every admin API call.
 *
 * Role policy is NOT redefined here. It used to be: this file carried its own
 * ADMIN_REALM_ROLES/ADMIN_CLIENT_ROLES sets and read `resource_access['admin-ui']`
 * literally — the exact drift lib/admin-roles.ts exists to prevent, and which it
 * already fixed for validateAdminToken. Two policies meant the admin guard could
 * admit a caller this factory then refused.
 *
 * Both refusals here are AUTHORIZATION failures (403), not authentication ones.
 * Reporting an insufficient grant as 401 told clients "your token is bad", so
 * they refreshed, retried with an identically-insufficient token, and span.
 */

/**
 * Standalone factory for creating a Keycloak admin client from a user token.
 * Shared by both the Elysia plugin (decorator) and the MCP tool executor.
 */
/** A Keycloak admin client acting as the caller. `read` also admits the auditor role; handlers opt in. */
export async function createAdminClient(userToken: string, access: AdminAccess = 'write') {
    try {
      // Check if Keycloak is configured
      if (!config.keycloak.isConfigured) {
        throw new ConfigurationError('Keycloak is not configured. Please configure Keycloak settings in the admin UI.')
      }

      logger.auth.debug('Keycloak plugin: Starting admin client creation', { tokenLength: userToken.length })
      logger.auth.debug('Validating user token for admin operations')
      // Validate the user's token and get payload
      const tokenPayload = (await validateToken(userToken)) as KeycloakJwtPayload
      const realmRoles = tokenPayload.realm_access?.roles || []
      const adminUiRoles =
        tokenPayload.resource_access?.[config.keycloak.adminUiClientId]?.roles || []
      const realmManagementRoles =
        tokenPayload.resource_access?.[KEYCLOAK_REALM_MANAGEMENT_CLIENT]?.roles || []

      logger.auth.debug('Token validated successfully', {
        sub: tokenPayload.sub,
        preferred_username: tokenPayload.preferred_username,
        email: tokenPayload.email,
        hasRealmAccess: !!tokenPayload.realm_access,
        hasResourceAccess: !!tokenPayload.resource_access,
        realmRoles,
        adminUiRoles,
        realmManagementRoles
      })

      // Only bypass in development when explicitly opted in
      const isDevelopment = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'

      if (!hasAdminAccess(tokenPayload, access)) {
        logger.auth.warn('User does not have admin permissions', {
          username: tokenPayload.preferred_username,
          realmRoles: realmRoles.slice(0, 5), // Log first 5 roles only
          isDevelopment
        })
        if (!isDevelopment) {
          throw new AuthorizationError('User does not have admin permissions')
        }
        logger.auth.warn('DEVELOPMENT: Proceeding despite missing admin role')
      }

      // Separate from the admin check above, and not redundant with it: this client drives
      // Keycloak's own Admin REST API with the CALLER's token, and Keycloak authorizes those
      // calls off realm-management roles alone. An admin of this product who holds no
      // realm-management role is legitimately an admin here and still cannot make those calls,
      // so refusing early beats a bare Keycloak 401 with no indication of which grant is missing.
      if (realmManagementRoles.length === 0) {
        logger.auth.warn('Admin lacks realm-management roles required for the Keycloak Admin API', {
          username: tokenPayload.preferred_username,
          realmRoles: realmRoles.slice(0, 5),
          isDevelopment
        })
        if (!isDevelopment) {
          throw new AuthorizationError(
            `This account administers ${config.name} but holds no ${KEYCLOAK_REALM_MANAGEMENT_CLIENT} ` +
            `client role, which Keycloak requires for admin API calls. Grant the needed ` +
            `${KEYCLOAK_REALM_MANAGEMENT_CLIENT} roles (e.g. view-users, manage-users) to this user or its realm role.`
          )
        }
        logger.auth.warn('DEVELOPMENT: Proceeding despite missing realm-management roles')
      }

      // Create admin client with user's token
      logger.auth.debug('Instantiating Keycloak admin client...')
      const kcAdminClient = new KcAdminClient({
        baseUrl: config.keycloak.baseUrl!,
        realmName: config.keycloak.realm!,
      })

      // Use the user's token for admin operations
      logger.auth.debug('Setting access token on admin client...')
      kcAdminClient.setAccessToken(userToken)
      
      logger.auth.debug('Keycloak admin client instantiated successfully', {
        username: tokenPayload.preferred_username,
        baseUrl: process.env.KEYCLOAK_BASE_URL,
        realm: process.env.KEYCLOAK_REALM
      })

      return kcAdminClient
    } catch (error) {
      logger.auth.error('Error in keycloak plugin', { error })
      
      // Re-throw typed errors as-is. AuthorizationError especially: the message-sniffing
      // below would otherwise rewrite a 403-class grant gap into a 401.
      if (
        error instanceof ConfigurationError ||
        error instanceof AuthenticationError ||
        error instanceof AuthorizationError
      ) {
        throw error
      }

      // For other errors, check if they might be auth-related
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Unauthorized') || 
          errorMessage.includes('Invalid token') ||
          errorMessage.includes('Token expired') ||
          errorMessage.includes('authentication') ||
          errorMessage.includes('401')) {
        throw new AuthenticationError(`Authentication failed: ${errorMessage}`);
      }
      
      // For all other errors, re-throw as-is
      throw error
    }
}

export const keycloakPlugin = new Elysia()
  .decorate('getAdmin', createAdminClient)
