// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  CommonErrorResponses,
  CreateIdentityProviderMapperRequest,
  UpdateIdentityProviderMapperRequest,
  IdentityProviderMapperResponse,
  IdentityProviderMapperStatusResponse,
  IdentityProviderMapperFixResponse,
  IdentityProviderMapperTypeResponse,
  SuccessResponse,
  type CreateIdentityProviderMapperRequestType,
  type UpdateIdentityProviderMapperRequestType,
  type IdentityProviderMapperResponseType,
  type IdentityProviderMapperStatusResponseType,
  type IdentityProviderMapperFixResponseType,
  type IdentityProviderMapperTypeResponseType,
  type SuccessResponseType,
  type ErrorResponseType
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { extractBearerToken } from '@/lib/admin-utils'
import { logger } from '@/lib/logger'
import {
  SMART_IDP_ATTRIBUTE_MAPPERS,
  ensureIdpAttributeMappers,
  flattenMapperConfig,
  getAllIdpMapperStatus,
  getIdpMapperStatus,
  normalizeIdpMapper,
  normalizeMapperTypeProperties
} from '@/lib/idp-mappers'

const aliasParams = t.Object({
  alias: t.String({ description: 'Identity provider alias' })
})

const mapperParams = t.Object({
  alias: t.String({ description: 'Identity provider alias' }),
  mapperId: t.String({ description: 'Identity provider mapper ID' })
})

/**
 * Identity Provider mapper management.
 *
 * Brokered users only carry the attributes an IdP mapper imports for them, so
 * these routes are what make a federated login usable for SMART launches:
 * `mapper-status` reports whether each provider imports `fhirUser`, `fix`
 * provisions what is missing, and the CRUD routes cover claim shapes that
 * differ from the defaults.
 */
export const identityProviderMapperRoutes = new Elysia({ prefix: '/idps' })
  .use(keycloakPlugin)

  .get('/mapper-status', async ({ getAdmin, headers, set }): Promise<IdentityProviderMapperStatusResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const status = await getAllIdpMapperStatus(admin)

      return {
        status,
        definitions: SMART_IDP_ATTRIBUTE_MAPPERS,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.admin.error('Failed to get IdP mapper status', { error })
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: IdentityProviderMapperStatusResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Identity Provider Mapper Status',
      description: 'Report, for every identity provider, whether the attribute imports SMART launches depend on (fhirUser, organization) are configured',
      tags: ['identity-providers']
    }
  })

  .get('/:alias/mapper-status', async ({ getAdmin, params, headers, set }): Promise<IdentityProviderMapperStatusResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const provider = await admin.identityProviders.findOne({ alias: params.alias })
      if (!provider) {
        set.status = 404
        return { error: 'Identity provider not found' }
      }

      const status = await getIdpMapperStatus(admin, { ...provider, alias: provider.alias ?? params.alias })

      return {
        status: [status],
        definitions: SMART_IDP_ATTRIBUTE_MAPPERS,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.admin.error('Failed to get IdP mapper status', { error, alias: params.alias })
      return handleAdminError(error, set)
    }
  }, {
    params: aliasParams,
    response: {
      200: IdentityProviderMapperStatusResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Mapper Status For Provider',
      description: 'Report whether a single identity provider has the attribute imports SMART launches depend on',
      tags: ['identity-providers']
    }
  })

  .get('/:alias/mapper-types', async ({ getAdmin, params, headers, set }): Promise<IdentityProviderMapperTypeResponseType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const types = await admin.identityProviders.findMapperTypes({ alias: params.alias })

      return Object.values(types)
        .filter((type): type is typeof type & { id: string } => !!type.id)
        .map(type => ({
          id: type.id,
          name: type.name,
          category: type.category,
          helpText: type.helpText,
          properties: normalizeMapperTypeProperties(type.properties)
        }))
    } catch (error) {
      logger.admin.error('Failed to list IdP mapper types', { error, alias: params.alias })
      return handleAdminError(error, set)
    }
  }, {
    params: aliasParams,
    response: {
      200: t.Array(IdentityProviderMapperTypeResponse),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List Identity Provider Mapper Types',
      description: 'Get the mapper types Keycloak supports for this provider, including their configurable properties',
      tags: ['identity-providers']
    }
  })

  .get('/:alias/mappers', async ({ getAdmin, params, headers, set }): Promise<IdentityProviderMapperResponseType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const mappers = await admin.identityProviders.findMappers({ alias: params.alias })
      return mappers.map(normalizeIdpMapper)
    } catch (error) {
      logger.admin.error('Failed to list IdP mappers', { error, alias: params.alias })
      return handleAdminError(error, set)
    }
  }, {
    params: aliasParams,
    response: {
      200: t.Array(IdentityProviderMapperResponse),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List Identity Provider Mappers',
      description: 'Get all claim/assertion mappers attached to an identity provider',
      tags: ['identity-providers']
    }
  })

  .post('/:alias/mappers', async ({ getAdmin, params, body, headers, set }): Promise<IdentityProviderMapperResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const provider = await admin.identityProviders.findOne({ alias: params.alias })
      if (!provider) {
        set.status = 404
        return { error: 'Identity provider not found' }
      }

      const payload = body as CreateIdentityProviderMapperRequestType
      const created = await admin.identityProviders.createMapper({
        alias: params.alias,
        identityProviderMapper: {
          name: payload.name,
          identityProviderAlias: params.alias,
          identityProviderMapper: payload.identityProviderMapper,
          config: payload.config
        }
      })

      logger.admin.info('Created IdP mapper', {
        alias: params.alias,
        mapper: payload.name,
        type: payload.identityProviderMapper
      })

      return normalizeIdpMapper({
        id: created.id,
        name: payload.name,
        identityProviderAlias: params.alias,
        identityProviderMapper: payload.identityProviderMapper,
        config: payload.config
      })
    } catch (error) {
      logger.admin.error('Failed to create IdP mapper', { error, alias: params.alias })
      return handleAdminError(error, set)
    }
  }, {
    params: aliasParams,
    body: CreateIdentityProviderMapperRequest,
    response: {
      200: IdentityProviderMapperResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Create Identity Provider Mapper',
      description: 'Attach a claim/assertion mapper to an identity provider',
      tags: ['identity-providers']
    }
  })

  .post('/:alias/mappers/fix', async ({ getAdmin, params, query, headers, set }): Promise<IdentityProviderMapperFixResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const provider = await admin.identityProviders.findOne({ alias: params.alias })
      if (!provider) {
        set.status = 404
        return { error: 'Identity provider not found' }
      }

      const result = await ensureIdpAttributeMappers(admin, params.alias, query.includeOptional !== 'false')

      const message = !result.userFacing
        ? 'This provider federates client assertions, not user logins — no attribute imports apply'
        : result.unsupported
          ? 'This provider type supports no attribute-import mappers'
          : result.created.length > 0
            ? `Provisioned ${result.created.length} mapper(s) on ${params.alias}`
            : 'All expected attribute mappers are already configured'

      logger.admin.info('IdP mapper fix completed', { ...result })

      return { message, ...result, timestamp: new Date().toISOString() }
    } catch (error) {
      logger.admin.error('Failed to provision IdP mappers', { error, alias: params.alias })
      return handleAdminError(error, set)
    }
  }, {
    params: aliasParams,
    query: t.Object({
      includeOptional: t.Optional(t.String({ description: 'Set to "false" to provision only required mappers' }))
    }),
    response: {
      200: IdentityProviderMapperFixResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Provision Missing Identity Provider Mappers',
      description: 'Auto-provision the attribute imports SMART launches depend on, using the mapper type this provider supports (idempotent)',
      tags: ['identity-providers']
    }
  })

  .put('/:alias/mappers/:mapperId', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const existing = await admin.identityProviders.findOneMapper({ alias: params.alias, id: params.mapperId })
      if (!existing) {
        set.status = 404
        return { error: 'Identity provider mapper not found' }
      }

      const payload = body as UpdateIdentityProviderMapperRequestType

      await admin.identityProviders.updateMapper(
        { alias: params.alias, id: params.mapperId },
        {
          ...existing,
          id: params.mapperId,
          identityProviderAlias: params.alias,
          name: payload.name ?? existing.name,
          identityProviderMapper: payload.identityProviderMapper ?? existing.identityProviderMapper,
          config: payload.config
            ? { ...flattenMapperConfig(existing.config), ...payload.config }
            : existing.config
        }
      )

      logger.admin.info('Updated IdP mapper', { alias: params.alias, mapperId: params.mapperId })

      return { success: true }
    } catch (error) {
      logger.admin.error('Failed to update IdP mapper', { error, ...params })
      return handleAdminError(error, set)
    }
  }, {
    params: mapperParams,
    body: UpdateIdentityProviderMapperRequest,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Update Identity Provider Mapper',
      description: 'Update a claim/assertion mapper. Config entries are merged into the existing configuration',
      tags: ['identity-providers']
    }
  })

  .delete('/:alias/mappers/:mapperId', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      await admin.identityProviders.delMapper({ alias: params.alias, id: params.mapperId })

      logger.admin.info('Deleted IdP mapper', { alias: params.alias, mapperId: params.mapperId })

      return { success: true }
    } catch (error) {
      logger.admin.error('Failed to delete IdP mapper', { error, ...params })
      return handleAdminError(error, set)
    }
  }, {
    params: mapperParams,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Delete Identity Provider Mapper',
      description: 'Remove a claim/assertion mapper from an identity provider',
      tags: ['identity-providers']
    }
  })
