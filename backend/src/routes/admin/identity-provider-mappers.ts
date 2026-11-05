// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderMapperRepresentation.js'
import type IdentityProviderRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderRepresentation.js'
import {
  CommonErrorResponses,
  CreateIdentityProviderMapperRequest,
  UpdateIdentityProviderMapperRequest,
  IdentityProviderMapperResponse,
  IdentityProviderMapperStatusResponse,
  IdentityProviderMapperFixResponse,
  IdentityProviderMapperTypeResponse,
  type IdentityProviderMapperStatusResponseType,
  type IdentityProviderMapperFixResponseType,
  type ErrorResponseType
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { requireAdminClient } from '@/lib/admin-utils'
import { logger } from '@/lib/logger'
import { fromKeycloakConfig } from '@/lib/keycloak-component-config'
import { keycloakMapperRoutes, MapperRequestError } from '@/lib/keycloak-mapper-routes'
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

async function requireProvider(admin: KcAdminClient, alias: string): Promise<IdentityProviderRepresentation> {
  const provider = await admin.identityProviders.findOne({ alias })
  if (!provider) throw new MapperRequestError(404, 'Identity provider not found')
  return provider
}

/** Keycloak resolves a mapper id realm-wide, so the alias in the path is checked here. */
async function requireProviderMapper(admin: KcAdminClient, alias: string, mapperId: string): Promise<IdentityProviderMapperRepresentation> {
  const mapper = await admin.identityProviders.findOneMapper({ alias, id: mapperId })
  if (mapper?.identityProviderAlias !== alias) throw new MapperRequestError(404, 'Identity provider mapper not found')
  return mapper
}

/** IdP mappers decide which attributes (fhirUser, organization) a brokered login imports onto the user. */
export const identityProviderMapperRoutes = keycloakMapperRoutes({
  prefix: '/idps',
  param: 'alias',
  paramDescription: 'Identity provider alias',
  mapperIdDescription: 'Identity provider mapper ID',
  tag: 'identity-providers',
  label: 'IdP mapper',
  schemas: {
    mapper: IdentityProviderMapperResponse,
    list: t.Array(IdentityProviderMapperResponse),
    create: CreateIdentityProviderMapperRequest,
    update: UpdateIdentityProviderMapperRequest,
  },
  store: {
    async list(admin, alias) {
      await requireProvider(admin, alias)
      return (await admin.identityProviders.findMappers({ alias })).map(normalizeIdpMapper)
    },
    async create(admin, alias, body) {
      await requireProvider(admin, alias)
      const mapper = { name: body.name, identityProviderAlias: alias, identityProviderMapper: body.identityProviderMapper, config: body.config }
      const created = await admin.identityProviders.createMapper({ alias, identityProviderMapper: mapper })
      return normalizeIdpMapper({ id: created.id, ...mapper })
    },
    async update(admin, alias, mapperId, body) {
      const existing = await requireProviderMapper(admin, alias, mapperId)
      await admin.identityProviders.updateMapper({ alias, id: mapperId }, {
        ...existing,
        id: mapperId,
        identityProviderAlias: alias,
        name: body.name ?? existing.name,
        identityProviderMapper: body.identityProviderMapper ?? existing.identityProviderMapper,
        config: body.config ? { ...fromKeycloakConfig(existing.config), ...body.config } : existing.config
      })
    },
    async remove(admin, alias, mapperId) {
      await requireProviderMapper(admin, alias, mapperId)
      await admin.identityProviders.delMapper({ alias, id: mapperId })
    },
  },
  types: {
    schema: t.Array(IdentityProviderMapperTypeResponse),
    doc: {
      summary: 'List Identity Provider Mapper Types',
      description: 'Get the mapper types Keycloak supports for this provider, including their configurable properties'
    },
    async list(admin, alias) {
      await requireProvider(admin, alias)
      const types = await admin.identityProviders.findMapperTypes({ alias })
      return Object.values(types)
        .filter((type): type is typeof type & { id: string } => !!type.id)
        .map(type => ({
          id: type.id,
          name: type.name,
          category: type.category,
          helpText: type.helpText,
          properties: normalizeMapperTypeProperties(type.properties)
        }))
    },
  },
  docs: {
    list: { summary: 'List Identity Provider Mappers', description: 'Get all claim/assertion mappers attached to an identity provider' },
    create: { summary: 'Create Identity Provider Mapper', description: 'Attach a claim/assertion mapper to an identity provider' },
    update: { summary: 'Update Identity Provider Mapper', description: 'Update a claim/assertion mapper. Config entries are merged into the existing configuration' },
    remove: { summary: 'Delete Identity Provider Mapper', description: 'Remove a claim/assertion mapper from an identity provider' },
  },
})
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
