// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  CommonErrorResponses,
  CreateUserFederationMapperRequest,
  UpdateUserFederationMapperRequest,
  UserFederationMapperResponse,
  UserFederationMapperTypeResponse,
  SuccessResponse,
  type CreateUserFederationMapperRequestType,
  type UpdateUserFederationMapperRequestType,
  type UserFederationMapperResponseType,
  type UserFederationMapperTypeResponseType,
  type SuccessResponseType,
  type ErrorResponseType
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { extractBearerToken } from '@/lib/admin-utils'
import { fromKeycloakConfig, toKeycloakConfig } from '@/lib/keycloak-component-config'
import { normalizeMapperTypeProperties } from '@/lib/idp-mappers'
import { logger } from '@/lib/logger'
import type ComponentRepresentation from '@keycloak/keycloak-admin-client/lib/defs/componentRepresentation.js'

/** Keycloak component type for LDAP attribute/group/role mappers */
export const LDAP_MAPPER_TYPE = 'org.keycloak.storage.ldap.mappers.LDAPStorageMapper'

const providerParams = t.Object({
  id: t.String({ description: 'User federation provider ID' })
})

const mapperParams = t.Object({
  id: t.String({ description: 'User federation provider ID' }),
  mapperId: t.String({ description: 'LDAP mapper (component) ID' })
})

const normalizeMapper = (component: ComponentRepresentation): UserFederationMapperResponseType => ({
  id: component.id,
  name: component.name,
  providerId: component.providerId,
  providerType: component.providerType,
  parentId: component.parentId,
  config: fromKeycloakConfig(component.config)
})

/**
 * LDAP mapper management for user federation providers.
 *
 * LDAP mappers decide which directory attributes reach the Keycloak user, so
 * they are what makes a federated directory user usable for SMART launches
 * (for example mapping an `fhirUser` directory attribute onto the user).
 */
export const userFederationMapperRoutes = new Elysia({ prefix: '/user-federation' })
  .use(keycloakPlugin)

  .get('/:id/mappers', async ({ getAdmin, params, headers, set }): Promise<UserFederationMapperResponseType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const mappers = await admin.components.find({
        parent: params.id,
        type: LDAP_MAPPER_TYPE
      })
      return mappers.map(normalizeMapper)
    } catch (error) {
      logger.admin.error('Failed to list LDAP mappers', { error, id: params.id })
      return handleAdminError(error, set)
    }
  }, {
    params: providerParams,
    response: {
      200: t.Array(UserFederationMapperResponse),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List LDAP Mappers',
      description: 'Get all attribute mappers for an LDAP federation provider',
      tags: ['user-federation']
    }
  })

  .get('/:id/mapper-types', async ({ getAdmin, params, headers, set }): Promise<UserFederationMapperTypeResponseType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const types = await admin.components.listSubComponents({
        id: params.id,
        type: LDAP_MAPPER_TYPE
      })

      return types.map(type => ({
        id: type.id,
        helpText: type.helpText,
        properties: normalizeMapperTypeProperties(type.properties)
      }))
    } catch (error) {
      logger.admin.error('Failed to list LDAP mapper types', { error, id: params.id })
      return handleAdminError(error, set)
    }
  }, {
    params: providerParams,
    response: {
      200: t.Array(UserFederationMapperTypeResponse),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List LDAP Mapper Types',
      description: 'Get the mapper types this LDAP provider supports, including their configurable properties',
      tags: ['user-federation']
    }
  })

  .post('/:id/mappers', async ({ getAdmin, params, body, headers, set }): Promise<UserFederationMapperResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const provider = await admin.components.findOne({ id: params.id })
      if (!provider) {
        set.status = 404
        return { error: 'User federation provider not found' }
      }

      const payload = body as CreateUserFederationMapperRequestType
      const created = await admin.components.create({
        name: payload.name,
        parentId: params.id,
        providerId: payload.providerId,
        providerType: LDAP_MAPPER_TYPE,
        config: toKeycloakConfig(payload.config)
      })

      logger.admin.info('Created LDAP mapper', {
        id: params.id,
        mapper: payload.name,
        type: payload.providerId
      })

      const mapper = await admin.components.findOne({ id: created.id })
      return normalizeMapper(mapper ?? {
        id: created.id,
        name: payload.name,
        parentId: params.id,
        providerId: payload.providerId,
        providerType: LDAP_MAPPER_TYPE,
        config: toKeycloakConfig(payload.config)
      })
    } catch (error) {
      logger.admin.error('Failed to create LDAP mapper', { error, id: params.id })
      return handleAdminError(error, set)
    }
  }, {
    params: providerParams,
    body: CreateUserFederationMapperRequest,
    response: {
      200: UserFederationMapperResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Create LDAP Mapper',
      description: 'Attach an attribute, group or role mapper to an LDAP federation provider',
      tags: ['user-federation']
    }
  })

  .put('/:id/mappers/:mapperId', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const existing = await admin.components.findOne({ id: params.mapperId })
      if (!existing || existing.parentId !== params.id) {
        set.status = 404
        return { error: 'LDAP mapper not found' }
      }

      const payload = body as UpdateUserFederationMapperRequestType

      await admin.components.update(
        { id: params.mapperId },
        {
          ...existing,
          id: params.mapperId,
          name: payload.name ?? existing.name,
          config: payload.config
            ? toKeycloakConfig({ ...fromKeycloakConfig(existing.config), ...payload.config })
            : existing.config
        }
      )

      logger.admin.info('Updated LDAP mapper', { id: params.id, mapperId: params.mapperId })

      return { success: true }
    } catch (error) {
      logger.admin.error('Failed to update LDAP mapper', { error, ...params })
      return handleAdminError(error, set)
    }
  }, {
    params: mapperParams,
    body: UpdateUserFederationMapperRequest,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Update LDAP Mapper',
      description: 'Update an LDAP mapper. Config entries are merged into the existing configuration',
      tags: ['user-federation']
    }
  })

  .delete('/:id/mappers/:mapperId', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const existing = await admin.components.findOne({ id: params.mapperId })
      if (!existing || existing.parentId !== params.id) {
        set.status = 404
        return { error: 'LDAP mapper not found' }
      }

      await admin.components.del({ id: params.mapperId })

      logger.admin.info('Deleted LDAP mapper', { id: params.id, mapperId: params.mapperId })

      return { success: true }
    } catch (error) {
      logger.admin.error('Failed to delete LDAP mapper', { error, ...params })
      return handleAdminError(error, set)
    }
  }, {
    params: mapperParams,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Delete LDAP Mapper',
      description: 'Remove a mapper from an LDAP federation provider',
      tags: ['user-federation']
    }
  })
