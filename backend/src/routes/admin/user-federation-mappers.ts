// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ComponentRepresentation from '@keycloak/keycloak-admin-client/lib/defs/componentRepresentation.js'
import {
  CreateUserFederationMapperRequest,
  UpdateUserFederationMapperRequest,
  UserFederationMapperResponse,
  UserFederationMapperTypeResponse,
  type UserFederationMapperResponseType
} from '@/schemas'
import { fromKeycloakConfig, toKeycloakConfig } from '@/lib/keycloak-component-config'
import { normalizeMapperTypeProperties } from '@/lib/idp-mappers'
import { keycloakMapperRoutes, MapperRequestError } from '@/lib/keycloak-mapper-routes'
import { findLdapMapper, findUserStorageProvider, LDAP_MAPPER_TYPE } from '@/lib/user-federation'

const normalizeMapper = (component: ComponentRepresentation): UserFederationMapperResponseType => ({
  id: component.id,
  name: component.name,
  providerId: component.providerId,
  providerType: component.providerType,
  parentId: component.parentId,
  config: fromKeycloakConfig(component.config)
})

async function requireProvider(admin: KcAdminClient, id: string): Promise<void> {
  if (!await findUserStorageProvider(admin, id)) throw new MapperRequestError(404, 'User federation provider not found')
}

async function requireMapper(admin: KcAdminClient, id: string, mapperId: string): Promise<ComponentRepresentation> {
  const mapper = await findLdapMapper(admin, id, mapperId)
  if (!mapper) throw new MapperRequestError(404, 'LDAP mapper not found')
  return mapper
}

/** LDAP mappers decide which directory attributes (such as fhirUser) reach the Keycloak user. */
export const userFederationMapperRoutes = keycloakMapperRoutes({
  prefix: '/user-federation',
  param: 'id',
  paramDescription: 'User federation provider ID',
  mapperIdDescription: 'LDAP mapper (component) ID',
  tag: 'user-federation',
  label: 'LDAP mapper',
  schemas: {
    mapper: UserFederationMapperResponse,
    list: t.Array(UserFederationMapperResponse),
    create: CreateUserFederationMapperRequest,
    update: UpdateUserFederationMapperRequest,
  },
  store: {
    async list(admin, id) {
      await requireProvider(admin, id)
      return (await admin.components.find({ parent: id, type: LDAP_MAPPER_TYPE })).map(normalizeMapper)
    },
    async create(admin, id, body) {
      await requireProvider(admin, id)
      const mapper = {
        name: body.name,
        parentId: id,
        providerId: body.providerId,
        providerType: LDAP_MAPPER_TYPE,
        config: toKeycloakConfig(body.config)
      }
      const created = await admin.components.create(mapper)
      return normalizeMapper(await admin.components.findOne({ id: created.id }) ?? { id: created.id, ...mapper })
    },
    async update(admin, id, mapperId, body) {
      const existing = await requireMapper(admin, id, mapperId)
      await admin.components.update({ id: mapperId }, {
        ...existing,
        id: mapperId,
        name: body.name ?? existing.name,
        config: body.config
          ? toKeycloakConfig({ ...fromKeycloakConfig(existing.config), ...body.config })
          : existing.config
      })
    },
    async remove(admin, id, mapperId) {
      await requireMapper(admin, id, mapperId)
      await admin.components.del({ id: mapperId })
    },
  },
  types: {
    schema: t.Array(UserFederationMapperTypeResponse),
    doc: {
      summary: 'List LDAP Mapper Types',
      description: 'Get the mapper types this LDAP provider supports, including their configurable properties'
    },
    async list(admin, id) {
      await requireProvider(admin, id)
      const types = await admin.components.listSubComponents({ id, type: LDAP_MAPPER_TYPE })
      return types.map(type => ({
        id: type.id,
        helpText: type.helpText,
        properties: normalizeMapperTypeProperties(type.properties)
      }))
    },
  },
  docs: {
    list: { summary: 'List LDAP Mappers', description: 'Get all attribute mappers for an LDAP federation provider' },
    create: { summary: 'Create LDAP Mapper', description: 'Attach an attribute, group or role mapper to an LDAP federation provider' },
    update: { summary: 'Update LDAP Mapper', description: 'Update an LDAP mapper. Config entries are merged into the existing configuration' },
    remove: { summary: 'Delete LDAP Mapper', description: 'Remove a mapper from an LDAP federation provider' },
  },
})
