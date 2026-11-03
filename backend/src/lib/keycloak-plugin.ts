// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import { validateToken } from './auth'
import { readKeycloakClaims } from './jwt-claims'
import { logger } from './logger'
import { AuthenticationError, AuthorizationError, ConfigurationError } from './admin-utils'
import { clientRoles, hasAdminAccess, KEYCLOAK_REALM_MANAGEMENT_CLIENT, realmRoles, type AdminAccess } from './admin-roles'
import { config } from '../config'

/**
 * A Keycloak admin client acting as the caller, so Keycloak's own RBAC applies to every call.
 * Role policy comes from lib/admin-roles; an insufficient grant is an AuthorizationError (403), not a 401.
 * `read` also admits the auditor role; handlers opt in.
 */
export async function createAdminClient(userToken: string, access: AdminAccess = 'write') {
    try {
      const { baseUrl, realm } = config.keycloak
      if (!baseUrl || !realm) {
        throw new ConfigurationError('Keycloak is not configured. Please configure Keycloak settings in the admin UI.')
      }

      const tokenPayload = readKeycloakClaims(await validateToken(userToken))
      const realmRoleList = realmRoles(tokenPayload)
      const adminUiRoles = clientRoles(tokenPayload, config.keycloak.adminUiClientId)
      const realmManagementRoles = clientRoles(tokenPayload, KEYCLOAK_REALM_MANAGEMENT_CLIENT)

      logger.auth.debug('Token validated successfully', {
        sub: tokenPayload.sub,
        preferred_username: tokenPayload.preferred_username,
        hasRealmAccess: !!tokenPayload.realm_access,
        hasResourceAccess: !!tokenPayload.resource_access,
        realmRoles: realmRoleList,
        adminUiRoles,
        realmManagementRoles
      })

      // Only bypass in development when explicitly opted in
      const isDevelopment = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'

      if (!hasAdminAccess(tokenPayload, access)) {
        logger.auth.warn('User does not have admin permissions', {
          username: tokenPayload.preferred_username,
          realmRoles: realmRoleList.slice(0, 5), // Log first 5 roles only
          isDevelopment
        })
        if (!isDevelopment) {
          throw new AuthorizationError('User does not have admin permissions')
        }
        logger.auth.warn('DEVELOPMENT: Proceeding despite missing admin role')
      }

      // Keycloak authorizes its Admin REST API off realm-management roles alone; refuse early with the missing grant named.
      if (realmManagementRoles.length === 0) {
        logger.auth.warn('Admin lacks realm-management roles required for the Keycloak Admin API', {
          username: tokenPayload.preferred_username,
          realmRoles: realmRoleList.slice(0, 5),
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

      const kcAdminClient = new KcAdminClient({
        baseUrl,
        realmName: realm,
      })
      kcAdminClient.setAccessToken(userToken)

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
