// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ProtocolMapperRepresentation from '@keycloak/keycloak-admin-client/lib/defs/protocolMapperRepresentation.js'
import {
  CommonErrorResponses,
  ClientIdParam,
  ProtocolMapperResponse,
  CreateProtocolMapperRequest,
  UpdateProtocolMapperRequest,
  AddAudienceMapperRequest,
  AddAudienceMapperResponse,
  type ProtocolMapperResponseType,
  type AddAudienceMapperResponseType,
  type ErrorResponseType
} from '@/schemas'
import { requireAdminClient } from '@/lib/admin-utils'
import { findRealmAppClient } from '@/lib/realm-clients'
import {
  AUDIENCE_MAPPER_TYPE,
  audienceKindOf,
  audienceMapper,
  audienceOf,
  isAudienceMapper,
  resolveAudienceKind,
} from '@/lib/audience-mapper'
import { invalidateClientConfig } from '@/lib/smart-client-config-cache'
import { fromKeycloakConfig } from '@/lib/keycloak-component-config'
import { handleMapperError, keycloakMapperRoutes, MapperRequestError } from '@/lib/keycloak-mapper-routes'
import { logger } from '@/lib/logger'

const OPENID_CONNECT = 'openid-connect'

const normalizeMapper = (mapper: ProtocolMapperRepresentation): ProtocolMapperResponseType => ({
  id: mapper.id,
  name: mapper.name,
  protocol: mapper.protocol,
  protocolMapper: mapper.protocolMapper,
  config: fromKeycloakConfig(mapper.config)
})

async function requireClientUuid(admin: KcAdminClient, clientId: string): Promise<string> {
  const internalId = (await findRealmAppClient(admin, clientId))?.id
  if (!internalId) throw new MapperRequestError(404, `Client '${clientId}' not found`)
  return internalId
}

async function requireMapper(admin: KcAdminClient, clientId: string, mapperId: string): Promise<{ id: string; mapper: ProtocolMapperRepresentation }> {
  const id = await requireClientUuid(admin, clientId)
  const mapper = await admin.clients.findProtocolMapperById({ id, mapperId })
  if (!mapper) throw new MapperRequestError(404, 'Protocol mapper not found on this client')
  return { id, mapper }
}

/** Mapper names are unique per client; naming the conflict beats Keycloak's bare 409. */
function rejectTakenName(mappers: ProtocolMapperRepresentation[], name: string, clientId: string): void {
  if (mappers.some(mapper => mapper.name === name)) {
    throw new MapperRequestError(409, `A protocol mapper named '${name}' already exists on client '${clientId}'`)
  }
}

/** Protocol mappers of a SMART app client, addressed by client id rather than Keycloak's internal UUID; every change drops the cached client config. */
export const smartAppMapperRoutes = keycloakMapperRoutes({
  prefix: '/smart-apps',
  param: 'clientId',
  paramDescription: 'OAuth2 client ID',
  mapperIdDescription: 'Protocol mapper ID',
  tag: 'smart-apps',
  label: 'client protocol mapper',
  schemas: {
    mapper: ProtocolMapperResponse,
    list: t.Array(ProtocolMapperResponse),
    create: CreateProtocolMapperRequest,
    update: UpdateProtocolMapperRequest,
  },
  store: {
    async list(admin, clientId) {
      const id = await requireClientUuid(admin, clientId)
      return (await admin.clients.listProtocolMappers({ id })).map(normalizeMapper)
    },
    async create(admin, clientId, body) {
      const id = await requireClientUuid(admin, clientId)
      rejectTakenName(await admin.clients.listProtocolMappers({ id }), body.name, clientId)
      const mapper = {
        name: body.name,
        protocol: body.protocol ?? OPENID_CONNECT,
        protocolMapper: body.protocolMapper,
        config: body.config ?? {}
      }
      await admin.clients.addProtocolMapper({ id }, mapper)
      invalidateClientConfig(clientId)
      const created = (await admin.clients.listProtocolMappers({ id })).find(existing => existing.name === body.name)
      return normalizeMapper(created ?? mapper)
    },
    async update(admin, clientId, mapperId, body) {
      const { id, mapper } = await requireMapper(admin, clientId, mapperId)
      await admin.clients.updateProtocolMapper({ id, mapperId }, {
        ...mapper,
        id: mapperId,
        name: body.name ?? mapper.name,
        config: body.config ? { ...mapper.config, ...body.config } : mapper.config
      })
      invalidateClientConfig(clientId)
    },
    async remove(admin, clientId, mapperId) {
      const { id } = await requireMapper(admin, clientId, mapperId)
      await admin.clients.delProtocolMapper({ id, mapperId })
      invalidateClientConfig(clientId)
    },
  },
  docs: {
    list: { summary: 'List Client Protocol Mappers', description: 'Get every protocol mapper attached to a SMART app client, resolved by client id' },
    create: { summary: 'Create Client Protocol Mapper', description: 'Attach a protocol mapper to a SMART app client. Mapper names are unique per client.' },
    update: { summary: 'Update Client Protocol Mapper', description: 'Update a protocol mapper on a SMART app client. Config entries are merged into the existing configuration.' },
    remove: { summary: 'Delete Client Protocol Mapper', description: 'Remove a protocol mapper from a SMART app client' },
  },
})
  /** Idempotently put an entry in the client's token audience; lib/audience-mapper picks the config key. */
  .post('/:clientId/mappers/audience', async ({ getAdmin, params, body, headers, set }): Promise<AddAudienceMapperResponseType | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const internalId = await requireClientUuid(admin, params.clientId)
      const existingMappers = await admin.clients.listProtocolMappers({ id: internalId })
      const alreadyThere = existingMappers.find(
        mapper => isAudienceMapper(mapper) && audienceOf(mapper) === body.audience
      )
      if (alreadyThere) {
        return {
          created: false,
          resolvedAs: audienceKindOf(alreadyThere),
          mapper: normalizeMapper(alreadyThere)
        }
      }

      const resolvedAs = await resolveAudienceKind(admin, body.audience)
      const name = body.name ?? `${body.audience}-audience`

      rejectTakenName(existingMappers, name, params.clientId)

      await admin.clients.addProtocolMapper(
        { id: internalId },
        audienceMapper(body.audience, resolvedAs, name, body.includeInIdToken ?? false)
      )

      invalidateClientConfig(params.clientId)

      logger.admin.info('Added audience mapper to client', {
        clientId: params.clientId,
        audience: body.audience,
        resolvedAs
      })

      const refreshed = await admin.clients.listProtocolMappers({ id: internalId })
      const created = refreshed.find(mapper => mapper.name === name)
      return {
        created: true,
        resolvedAs,
        mapper: normalizeMapper(created ?? { name, protocol: OPENID_CONNECT, protocolMapper: AUDIENCE_MAPPER_TYPE })
      }
    } catch (error) {
      return handleMapperError(error, set, 'Failed to add audience mapper', { clientId: params.clientId })
    }
  }, {
    params: ClientIdParam,
    body: AddAudienceMapperRequest,
    response: {
      200: AddAudienceMapperResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Add Audience Mapper',
      description:
        'Idempotently add an oidc-audience-mapper to a SMART app client. The audience may be another realm client id or a literal URL; the route picks the correct Keycloak config key for each.',
      tags: ['smart-apps']
    }
  })
