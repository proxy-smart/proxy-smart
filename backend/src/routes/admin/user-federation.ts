// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
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
  type LdapTestConnectionRequestType,
  type LdapTestConnectionResponseType,
  type CountResponseType,
  type SuccessResponseType,
  type ErrorResponseType,
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { requireAdminClient } from '@/lib/admin-utils'
import { fromKeycloakConfig, toKeycloakConfig } from '@/lib/keycloak-component-config'
import { maskSecretFields } from '@/lib/secret-mask'
import { isRecord } from '@/lib/type-guards'
import { findUserStorageProvider, LDAP_PROVIDER_ID, USER_STORAGE_PROVIDER_TYPE } from '@/lib/user-federation'
import type ComponentRepresentation from '@keycloak/keycloak-admin-client/lib/defs/componentRepresentation.js'

const PROVIDER_NOT_FOUND: ErrorResponseType = { error: 'User federation provider not found' }

const providerParams = t.Object({
  id: t.String({ description: 'User federation provider ID' })
})

const normalizeProvider = (component: ComponentRepresentation): UserFederationProviderResponseType => ({
  id: component.id,
  name: component.name,
  providerId: component.providerId,
  providerType: component.providerType,
  parentId: component.parentId,
  config: maskSecretFields(fromKeycloakConfig(component.config), ['bindCredential']),
})

type LdapTestAction = 'testConnection' | 'testAuthentication'

const LDAP_TEST_LABEL: Record<LdapTestAction, string> = {
  testConnection: 'LDAP connection test',
  testAuthentication: 'LDAP authentication test',
}

async function runLdapTest(
  admin: KcAdminClient,
  action: LdapTestAction,
  payload: LdapTestConnectionRequestType,
  set: { status?: number | string },
): Promise<LdapTestConnectionResponseType | ErrorResponseType> {
  try {
    await admin.realms.testLDAPConnection(
      { realm: admin.realmName },
      {
        action,
        connectionUrl: payload.connectionUrl,
        bindDn: payload.bindDn,
        bindCredential: payload.bindCredential,
        useTruststoreSpi: payload.useTruststoreSpi ?? 'ldapsOnly',
        connectionTimeout: payload.connectionTimeout,
        startTls: payload.startTls,
        authType: payload.authType ?? 'simple',
      },
    )
    return { success: true, message: `${LDAP_TEST_LABEL[action]} successful` }
  } catch (error) {
    if (isRecord(error) && 'response' in error) {
      set.status = 400
      return { error: `${LDAP_TEST_LABEL[action]} failed` }
    }
    throw error
  }
}

/** LDAP user storage providers; mapper routes for them live in ./user-federation-mappers. */
export const userFederationRoutes = new Elysia({ prefix: '/user-federation' })
  .use(keycloakPlugin)

  .get('/count', async ({ getAdmin, headers, set }): Promise<CountResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const components = await admin.components.find({ type: USER_STORAGE_PROVIDER_TYPE })
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

  .get('/', async ({ getAdmin, headers, set }): Promise<UserFederationProviderResponseType[] | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const components = await admin.components.find({ type: USER_STORAGE_PROVIDER_TYPE })
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

  .post('/', async ({ getAdmin, body, headers, set }): Promise<UserFederationProviderResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const componentPayload: ComponentRepresentation = {
        name: body.name,
        providerId: LDAP_PROVIDER_ID,
        providerType: USER_STORAGE_PROVIDER_TYPE,
        config: toKeycloakConfig(body.config),
      }

      const { id } = await admin.components.create(componentPayload)
      const created = await admin.components.findOne({ id })
      return normalizeProvider(created ?? { ...componentPayload, id })
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

  .get('/:id', async ({ getAdmin, params, headers, set }): Promise<UserFederationProviderResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const component = await findUserStorageProvider(admin, params.id)
      if (!component) {
        set.status = 404
        return PROVIDER_NOT_FOUND
      }
      return normalizeProvider(component)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: providerParams,
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

  .put('/:id', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const existing = await findUserStorageProvider(admin, params.id)
      if (!existing) {
        set.status = 404
        return PROVIDER_NOT_FOUND
      }

      await admin.components.update({ id: params.id }, {
        ...existing,
        name: body.name ?? existing.name,
        config: body.config ? toKeycloakConfig(body.config) : existing.config,
      })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: providerParams,
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

  .delete('/:id', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      if (!await findUserStorageProvider(admin, params.id)) {
        set.status = 404
        return PROVIDER_NOT_FOUND
      }
      await admin.components.del({ id: params.id })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: providerParams,
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

  .post('/:id/sync', async ({ getAdmin, params, body, headers, set }): Promise<UserFederationSyncResultResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      if (!await findUserStorageProvider(admin, params.id)) {
        set.status = 404
        return PROVIDER_NOT_FOUND
      }
      const result = await admin.userStorageProvider.sync({ id: params.id, action: body.action })
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
    params: providerParams,
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

  .post('/:id/remove-imported', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      if (!await findUserStorageProvider(admin, params.id)) {
        set.status = 404
        return PROVIDER_NOT_FOUND
      }
      await admin.userStorageProvider.removeImportedUsers({ id: params.id })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: providerParams,
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

  .post('/:id/unlink', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      if (!await findUserStorageProvider(admin, params.id)) {
        set.status = 404
        return PROVIDER_NOT_FOUND
      }
      await admin.userStorageProvider.unlinkUsers({ id: params.id })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: providerParams,
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

  .post('/test-connection', async ({ getAdmin, body, headers, set }): Promise<LdapTestConnectionResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      return await runLdapTest(admin, 'testConnection', body, set)
    } catch (error) {
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

  .post('/test-authentication', async ({ getAdmin, body, headers, set }): Promise<LdapTestConnectionResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      return await runLdapTest(admin, 'testAuthentication', body, set)
    } catch (error) {
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
