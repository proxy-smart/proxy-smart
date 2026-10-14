// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  CommonErrorResponses,
  CreateUserFederationRequest,
  UpdateUserFederationRequest,
  UserFederationSyncRequest,
  LdapTestConnectionRequest,
  UserFederationProviderResponse,
  UserFederationSyncResultResponse,
  LdapTestConnectionResponse,
  CountResponse,
  SuccessResponse,
  type UserFederationProviderResponseType,
  type UserFederationSyncResultResponseType,
  type LdapTestConnectionResponseType,
  type CountResponseType,
  type SuccessResponseType,
  type ErrorResponseType,
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { fromKeycloakConfig, toKeycloakConfig } from '@/lib/keycloak-component-config'
import { maskSecretFields } from '@/lib/secret-mask'
import { config } from '@/config'
import type ComponentRepresentation from '@keycloak/keycloak-admin-client/lib/defs/componentRepresentation.js'

const PROVIDER_TYPE = 'org.keycloak.storage.UserStorageProvider'
const LDAP_PROVIDER_ID = 'ldap'

const normalizeProvider = (component: ComponentRepresentation): UserFederationProviderResponseType => ({
  id: component.id,
  name: component.name,
  providerId: component.providerId,
  providerType: component.providerType,
  parentId: component.parentId,
  config: maskSecretFields(fromKeycloakConfig(component.config), ['bindCredential']),
})

const extractToken = (authorization?: string): string | null =>
  authorization?.replace('Bearer ', '') || null

/**
 * User Federation (LDAP) routes - manages Keycloak User Storage Provider components
 */
export const userFederationRoutes = new Elysia({ prefix: '/user-federation' })
  .use(keycloakPlugin)

  // ==================== Count ====================
  .get('/count', async ({ getAdmin, headers, set }): Promise<CountResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const components = await admin.components.find({ type: PROVIDER_TYPE })
      const ldapComponents = components.filter(c => c.providerId === LDAP_PROVIDER_ID)
      return { count: ldapComponents.length, total: components.length }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: CountResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Get User Federation Count',
      description: 'Get the count of configured LDAP user federation providers',
      tags: ['user-federation'],
    },
  })

  // ==================== List ====================
  .get('/', async ({ getAdmin, headers, set }): Promise<UserFederationProviderResponseType[] | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const components = await admin.components.find({ type: PROVIDER_TYPE })
      return components
        .filter(c => c.providerId === LDAP_PROVIDER_ID)
        .map(normalizeProvider)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: t.Array(UserFederationProviderResponse),
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'List LDAP Federations',
      description: 'Get all configured LDAP user federation providers',
      tags: ['user-federation'],
    },
  })

  // ==================== Create ====================
  .post('/', async ({ getAdmin, body, headers, set }): Promise<UserFederationProviderResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const payload = body

      const componentPayload: ComponentRepresentation = {
        name: payload.name,
        providerId: LDAP_PROVIDER_ID,
        providerType: PROVIDER_TYPE,
        config: toKeycloakConfig(payload.config),
      }

      const { id } = await admin.components.create(componentPayload)
      const created = await admin.components.findOne({ id })
      if (!created) {
        return normalizeProvider({ ...componentPayload, id })
      }
      return normalizeProvider(created)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: CreateUserFederationRequest,
    response: {
      200: UserFederationProviderResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Create LDAP Federation',
      description: 'Create a new LDAP user federation provider',
      tags: ['user-federation'],
    },
  })

  // ==================== Get by ID ====================
  .get('/:id', async ({ getAdmin, params, headers, set }): Promise<UserFederationProviderResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const component = await admin.components.findOne({ id: params.id })
      if (!component || component.providerType !== PROVIDER_TYPE) {
        set.status = 404
        return { error: 'User federation provider not found' }
      }
      return normalizeProvider(component)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      id: t.String({ description: 'User federation provider ID' })
    }),
    response: {
      200: UserFederationProviderResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Get LDAP Federation',
      description: 'Get an LDAP user federation provider by ID',
      tags: ['user-federation'],
    },
  })

  // ==================== Update ====================
  .put('/:id', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const existing = await admin.components.findOne({ id: params.id })
      if (!existing || existing.providerType !== PROVIDER_TYPE) {
        set.status = 404
        return { error: 'User federation provider not found' }
      }

      const payload = body
      const updated: ComponentRepresentation = {
        ...existing,
        name: payload.name ?? existing.name,
        config: payload.config
          ? toKeycloakConfig(payload.config)
          : existing.config,
      }

      await admin.components.update({ id: params.id }, updated)
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      id: t.String({ description: 'User federation provider ID' })
    }),
    body: UpdateUserFederationRequest,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Update LDAP Federation',
      description: 'Update an LDAP user federation provider',
      tags: ['user-federation'],
    },
  })

  // ==================== Delete ====================
  .delete('/:id', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      await admin.components.del({ id: params.id })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      id: t.String({ description: 'User federation provider ID' })
    }),
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Delete LDAP Federation',
      description: 'Delete an LDAP user federation provider',
      tags: ['user-federation'],
    },
  })

  // ==================== Sync Users ====================
  .post('/:id/sync', async ({ getAdmin, params, body, headers, set }): Promise<UserFederationSyncResultResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const syncBody = body
      const result = await admin.userStorageProvider.sync({
        id: params.id,
        action: syncBody.action,
      })
      return {
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        failed: result.failed,
        status: result.status,
        ignored: result.ignored,
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      id: t.String({ description: 'User federation provider ID' })
    }),
    body: UserFederationSyncRequest,
    response: {
      200: UserFederationSyncResultResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Sync LDAP Users',
      description: 'Trigger a full or changed-users sync for an LDAP federation provider',
      tags: ['user-federation'],
    },
  })

  // ==================== Remove Imported Users ====================
  .post('/:id/remove-imported', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      await admin.userStorageProvider.removeImportedUsers({ id: params.id })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      id: t.String({ description: 'User federation provider ID' })
    }),
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Remove Imported Users',
      description: 'Remove all users imported from this LDAP federation provider',
      tags: ['user-federation'],
    },
  })

  // ==================== Unlink Users ====================
  .post('/:id/unlink', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      await admin.userStorageProvider.unlinkUsers({ id: params.id })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      id: t.String({ description: 'User federation provider ID' })
    }),
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Unlink Federated Users',
      description: 'Unlink all users federated from this LDAP provider',
      tags: ['user-federation'],
    },
  })

  // ==================== Test LDAP Connection ====================
  .post('/test-connection', async ({ getAdmin, body, headers, set }): Promise<LdapTestConnectionResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const payload = body

      await admin.realms.testLDAPConnection(
        { realm: config.keycloak.realm! },
        {
          action: 'testConnection',
          connectionUrl: payload.connectionUrl,
          bindDn: payload.bindDn,
          bindCredential: payload.bindCredential,
          useTruststoreSpi: payload.useTruststoreSpi ?? 'ldapsOnly',
          connectionTimeout: payload.connectionTimeout,
          startTls: payload.startTls,
          authType: payload.authType ?? 'simple',
        },
      )
      return { success: true, message: 'LDAP connection test successful' }
    } catch (error) {
      // Connection test failures often return 400 from Keycloak
      if (error && typeof error === 'object' && 'response' in error) {
        set.status = 400
        return { success: false, message: 'LDAP connection test failed' }
      }
      return handleAdminError(error, set)
    }
  }, {
    body: LdapTestConnectionRequest,
    response: {
      200: LdapTestConnectionResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Test LDAP Connection',
      description: 'Test connectivity to an LDAP server before saving configuration',
      tags: ['user-federation'],
    },
  })

  // ==================== Test LDAP Authentication ====================
  .post('/test-authentication', async ({ getAdmin, body, headers, set }): Promise<LdapTestConnectionResponseType | ErrorResponseType> => {
    try {
      const token = extractToken(headers.authorization)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const payload = body

      await admin.realms.testLDAPConnection(
        { realm: config.keycloak.realm! },
        {
          action: 'testAuthentication',
          connectionUrl: payload.connectionUrl,
          bindDn: payload.bindDn,
          bindCredential: payload.bindCredential,
          useTruststoreSpi: payload.useTruststoreSpi ?? 'ldapsOnly',
          connectionTimeout: payload.connectionTimeout,
          startTls: payload.startTls,
          authType: payload.authType ?? 'simple',
        },
      )
      return { success: true, message: 'LDAP authentication test successful' }
    } catch (error) {
      if (error && typeof error === 'object' && 'response' in error) {
        set.status = 400
        return { success: false, message: 'LDAP authentication test failed' }
      }
      return handleAdminError(error, set)
    }
  }, {
    body: LdapTestConnectionRequest,
    response: {
      200: LdapTestConnectionResponse,
      ...CommonErrorResponses,
    },
    detail: {
      summary: 'Test LDAP Authentication',
      description: 'Test authentication (bind) to an LDAP server',
      tags: ['user-federation'],
    },
  })

// Mapper routes for these providers live in ./user-federation-mappers
