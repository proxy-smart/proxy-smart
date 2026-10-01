// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * `proxy-smart user-federation <verb>`: LDAP providers and their mappers.
 * No fix verb: the directory attribute holding the FHIR reference is deployment-specific.
 */
import {
  CreateUserFederationRequestFromJSON,
  CreateUserFederationMapperRequestFromJSON,
  UpdateUserFederationRequestFromJSON,
  UpdateUserFederationMapperRequestFromJSON,
} from '../api-client'
import { flagBool, flagString, type ParsedArgs } from '../args'
import { CliError } from '../output'
import { requirePositional } from './shared'
import { jsonVerb, nestedListVerb, verbCommand } from './verbs/core'
import { crudVerbs } from './verbs/crud'
import { mapperVerbs } from './verbs/mappers'

/** Keycloak user attribute a SMART launch resolves the imported user through */
const SMART_USER_ATTRIBUTE = 'fhirUser'

const providers = crudVerbs({
  key: 'id',
  list: { fetch: ({ api }) => api.userFederation.getAdminUserFederation(), rows: items => items },
  get: (api, id) => api.userFederation.getAdminUserFederationById({ id }),
  create: (api, data) => api.userFederation.postAdminUserFederation({
    createUserFederationRequest: CreateUserFederationRequestFromJSON(data),
  }),
  update: (api, data, id) => api.userFederation.putAdminUserFederationById({
    id,
    updateUserFederationRequest: UpdateUserFederationRequestFromJSON(data),
  }),
  remove: (api, id) => api.userFederation.deleteAdminUserFederationById({ id }),
  confirmRemove: () => 'Deleting a federation provider unlinks its imported users. Re-run with --yes.',
})

function syncAction(args: ParsedArgs): 'triggerFullSync' | 'triggerChangedUsersSync' {
  const action = flagString(args.flags, 'action') ?? 'triggerFullSync'
  if (action !== 'triggerFullSync' && action !== 'triggerChangedUsersSync') {
    throw new CliError('--action must be triggerFullSync or triggerChangedUsersSync.')
  }
  return action
}

const sync = jsonVerb(
  args => ({ id: requirePositional(args, 2, 'id'), action: syncAction(args) }),
  (api, { id, action }) => api.userFederation.postAdminUserFederationByIdSync({
    id,
    userFederationSyncRequest: { action },
  }),
)

const mappers = mapperVerbs({
  parent: 'id',
  list: (api, id) => api.userFederation.getAdminUserFederationByIdMappers({ id }),
  row: mapper => {
    const config: Record<string, unknown> = mapper.config ?? {}
    return {
      id: mapper.id ?? '-',
      name: mapper.name ?? '-',
      ldapAttribute: config['ldap.attribute'] ?? '-',
      userAttribute: config['user.model.attribute'] ?? '-',
      type: mapper.providerId ?? '-',
    }
  },
  check: (ctx, rows) => {
    if (flagBool(ctx.args.flags, 'strict') && !rows.some(row => row.userAttribute === SMART_USER_ATTRIBUTE)) {
      throw new CliError(`No mapper writes the ${SMART_USER_ATTRIBUTE} user attribute.`)
    }
  },
  create: (api, data, id) => api.userFederation.postAdminUserFederationByIdMappers({
    id,
    createUserFederationMapperRequest: CreateUserFederationMapperRequestFromJSON(data),
  }),
  update: (api, data, { parentId, mapperId }) => api.userFederation.putAdminUserFederationByIdMappersByMapperId({
    id: parentId,
    mapperId,
    updateUserFederationMapperRequest: UpdateUserFederationMapperRequestFromJSON(data),
  }),
  remove: (api, { parentId, mapperId }) =>
    api.userFederation.deleteAdminUserFederationByIdMappersByMapperId({ id: parentId, mapperId }),
})

const mapperTypes = nestedListVerb(
  'id',
  (api, id) => api.userFederation.getAdminUserFederationByIdMapperTypes({ id }),
  type => ({
    id: type.id,
    properties: type.properties.map(property => property.name).join(','),
  }),
)

export const userFederationCommand = verbCommand('user-federation', {
  ...providers,
  sync,
  mappers: mappers.list,
  'mapper-types': mapperTypes,
  'create-mapper': mappers.create,
  'update-mapper': mappers.update,
  'delete-mapper': mappers.delete,
})
