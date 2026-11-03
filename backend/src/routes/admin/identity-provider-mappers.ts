// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderMapperRepresentation.js'
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
  type IdentityProviderMapperResponseType,
  type IdentityProviderMapperStatusResponseType,
  type IdentityProviderMapperFixResponseType,
  type IdentityProviderMapperTypeResponseType,
  type SuccessResponseType,
  type ErrorResponseType
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { requireAdminClient } from '@/lib/admin-utils'
import { logger } from '@/lib/logger'
import { fromKeycloakConfig } from '@/lib/keycloak-component-config'
import {
  SMART_IDP_ATTRIBUTE_MAPPERS,
  ensureIdpAttributeMappers,
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

const MAPPER_NOT_FOUND: ErrorResponseType = { error: 'Identity provider mapper not found' }

/** Keycloak resolves a mapper id realm-wide, so the alias in the path is checked here. */
async function findProviderMapper(admin: KcAdminClient, alias: string, mapperId: string): Promise<IdentityProviderMapperRepresentation | undefined> {
  const mapper = await admin.identityProviders.findOneMapper({ alias, id: mapperId })
  return mapper?.identityProviderAlias === alias ? mapper : undefined
}

/** IdP mappers decide which attributes (fhirUser, organization) a brokered login imports onto the user. */
export const identityProviderMapperRoutes = new Elysia({ prefix: '/idps' })
  .use(keycloakPlugin)

  .get('/mapper-status', async ({ getAdmin, headers, set }): Promise<IdentityProviderMapperStatusResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers }, 'read')
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
      const admin = await requireAdminClient({ getAdmin, headers }, 'read')
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
      const admin = await requireAdminClient({ getAdmin, headers }, 'read')
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
      const admin = await requireAdminClient({ getAdmin, headers }, 'read')
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
      const admin = await requireAdminClient({ getAdmin, headers })
      const provider = await admin.identityProviders.findOne({ alias: params.alias })
      if (!provider) {
        set.status = 404
        return { error: 'Identity provider not found' }
      }

      const payload = body
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
      const admin = await requireAdminClient({ getAdmin, headers })
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
      const admin = await requireAdminClient({ getAdmin, headers })
      const existing = await findProviderMapper(admin, params.alias, params.mapperId)
      if (!existing) {
        set.status = 404
        return MAPPER_NOT_FOUND
      }

      const payload = body

      await admin.identityProviders.updateMapper(
        { alias: params.alias, id: params.mapperId },
        {
          ...existing,
          id: params.mapperId,
          identityProviderAlias: params.alias,
          name: payload.name ?? existing.name,
          identityProviderMapper: payload.identityProviderMapper ?? existing.identityProviderMapper,
          config: payload.config
            ? { ...fromKeycloakConfig(existing.config), ...payload.config }
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
      const admin = await requireAdminClient({ getAdmin, headers })
      if (!await findProviderMapper(admin, params.alias, params.mapperId)) {
        set.status = 404
        return MAPPER_NOT_FOUND
      }
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
