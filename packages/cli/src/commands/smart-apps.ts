// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * `proxy-smart smart-apps <verb>`: SMART on FHIR applications and their protocol mappers.
 * `add-audience` lets the proxy pick the Keycloak config key the `aud` entry needs.
 */
import {
  CreateSmartAppRequestFromJSON,
  UpdateSmartAppRequestFromJSON,
  CreateProtocolMapperRequestFromJSON,
  UpdateProtocolMapperRequestFromJSON,
} from '../api-client'
import { flagBool, flagString } from '../args'
import { requirePositional } from './shared'
import { jsonVerb, verbCommand } from './verbs/core'
import { crudVerbs } from './verbs/crud'
import { mapperVerbs } from './verbs/mappers'

const apps = crudVerbs({
  key: 'clientId',
  list: { fetch: ({ api }) => api.smartApps.getAdminSmartApps(), rows: items => items },
  get: (api, clientId) => api.smartApps.getAdminSmartAppsByClientId({ clientId }),
  create: (api, data) => api.smartApps.postAdminSmartApps({
    createSmartAppRequest: CreateSmartAppRequestFromJSON(data),
  }),
  update: (api, data, clientId) => api.smartApps.putAdminSmartAppsByClientId({
    clientId,
    updateSmartAppRequest: UpdateSmartAppRequestFromJSON(data),
  }),
  remove: (api, clientId) => api.smartApps.deleteAdminSmartAppsByClientId({ clientId }),
})

/** Rows show the audience or claim each mapper emits: what a wrong token is checked against. */
const mappers = mapperVerbs({
  parent: 'clientId',
  list: (api, clientId) => api.smartApps.getAdminSmartAppsByClientIdMappers({ clientId }),
  row: mapper => {
    const config = mapper.config ?? {}
    return {
      id: mapper.id ?? '-',
      name: mapper.name ?? '-',
      type: mapper.protocolMapper ?? '-',
      audience: config['included.client.audience'] || config['included.custom.audience'] || '-',
      claim: config['claim.name'] ?? '-',
      accessToken: config['access.token.claim'] ?? '-',
    }
  },
  create: (api, data, clientId) => api.smartApps.postAdminSmartAppsByClientIdMappers({
    clientId,
    createProtocolMapperRequest: CreateProtocolMapperRequestFromJSON(data),
  }),
  update: (api, data, { parentId, mapperId }) => api.smartApps.putAdminSmartAppsByClientIdMappersByMapperId({
    clientId: parentId,
    mapperId,
    updateProtocolMapperRequest: UpdateProtocolMapperRequestFromJSON(data),
  }),
  remove: (api, { parentId, mapperId }) =>
    api.smartApps.deleteAdminSmartAppsByClientIdMappersByMapperId({ clientId: parentId, mapperId }),
})

/** Idempotent, so deploy and reconcile steps can run it unguarded. */
const addAudience = jsonVerb(
  args => ({
    clientId: requirePositional(args, 2, 'clientId'),
    addAudienceMapperRequest: {
      audience: requirePositional(args, 3, 'audience'),
      name: flagString(args.flags, 'name'),
      includeInIdToken: flagBool(args.flags, 'id-token') ? true : undefined,
    },
  }),
  (api, request) => api.smartApps.postAdminSmartAppsByClientIdMappersAudience(request),
)

export const smartAppsCommand = verbCommand('smart-apps', {
  ...apps,
  mappers: mappers.list,
  'create-mapper': mappers.create,
  'update-mapper': mappers.update,
  'delete-mapper': mappers.delete,
  'add-audience': addAudience,
})
