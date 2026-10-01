// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** `proxy-smart idps <verb>`: identity providers and the claim mappers brokered users depend on. */
import {
  CreateIdentityProviderRequestFromJSON,
  CreateIdentityProviderMapperRequestFromJSON,
  UpdateIdentityProviderRequestFromJSON,
  UpdateIdentityProviderMapperRequestFromJSON,
} from '../api-client'
import { flagBool } from '../args'
import { CliError, printJson } from '../output'
import { requirePositional, type CommandContext } from './shared'
import { listVerb, nestedListVerb, verbCommand } from './verbs/core'
import { crudVerbs } from './verbs/crud'
import { mapperVerbs } from './verbs/mappers'

const providers = crudVerbs({
  key: 'alias',
  list: { fetch: ({ api }) => api.identityProviders.getAdminIdps(), rows: items => items },
  get: (api, alias) => api.identityProviders.getAdminIdpsByAlias({ alias }),
  create: (api, data) => api.identityProviders.postAdminIdps({
    createIdentityProviderRequest: CreateIdentityProviderRequestFromJSON(data),
  }),
  update: (api, data, alias) => api.identityProviders.putAdminIdpsByAlias({
    alias,
    updateIdentityProviderRequest: UpdateIdentityProviderRequestFromJSON(data),
  }),
  remove: (api, alias) => api.identityProviders.deleteAdminIdpsByAlias({ alias }),
})

const mappers = mapperVerbs({
  parent: 'alias',
  list: (api, alias) => api.identityProviders.getAdminIdpsByAliasMappers({ alias }),
  row: mapper => ({
    id: mapper.id ?? '-',
    name: mapper.name,
    claim: mapper.externalName ?? '-',
    userAttribute: mapper.userAttribute ?? '-',
    syncMode: mapper.syncMode ?? '-',
    type: mapper.identityProviderMapper,
  }),
  create: (api, data, alias) => api.identityProviders.postAdminIdpsByAliasMappers({
    alias,
    createIdentityProviderMapperRequest: CreateIdentityProviderMapperRequestFromJSON(data),
  }),
  update: (api, data, { parentId, mapperId }) => api.identityProviders.putAdminIdpsByAliasMappersByMapperId({
    alias: parentId,
    mapperId,
    updateIdentityProviderMapperRequest: UpdateIdentityProviderMapperRequestFromJSON(data),
  }),
  remove: (api, { parentId, mapperId }) =>
    api.identityProviders.deleteAdminIdpsByAliasMappersByMapperId({ alias: parentId, mapperId }),
})

const mapperTypes = nestedListVerb(
  'alias',
  (api, alias) => api.identityProviders.getAdminIdpsByAliasMapperTypes({ alias }),
  type => ({
    id: type.id,
    name: type.name ?? '-',
    category: type.category ?? '-',
    properties: type.properties.map(property => property.name).join(','),
  }),
)

/** Realm-wide without an alias; non-zero exit on drift under --strict, so it works as a CI gate. */
const mapperStatus = listVerb({
  fetch: ({ api, args }) => {
    const alias = args.positionals[2]
    return alias === undefined
      ? api.identityProviders.getAdminIdpsMapperStatus()
      : api.identityProviders.getAdminIdpsByAliasMapperStatus({ alias })
  },
  rows: response => response.status.map(entry => ({
    alias: entry.alias,
    providerId: entry.providerId,
    enabled: entry.enabled,
    // Machine trust anchors broker client assertions, not users, so imports do not apply.
    healthy: entry.userFacing ? entry.healthy : 'n/a',
    missingRequired: entry.missingRequired.join(',') || '-',
    missingOptional: entry.missingOptional.join(',') || '-',
    mapperType: entry.attributeMapperType ?? '-',
  })),
  check: (ctx, _rows, response) => {
    const unhealthy = response.status.filter(entry => entry.userFacing && !entry.healthy)
    if (flagBool(ctx.args.flags, 'strict') && unhealthy.length > 0) {
      throw new CliError(
        `Missing required attribute imports on: ${unhealthy.map(entry => entry.alias).join(', ')}.`,
      )
    }
  },
})

async function fixMappers(ctx: CommandContext): Promise<void> {
  const alias = requirePositional(ctx.args, 2, 'alias')
  const result = await ctx.api.identityProviders.postAdminIdpsByAliasMappersFix({
    alias,
    includeOptional: flagBool(ctx.args.flags, 'required-only') ? 'false' : undefined,
  })
  printJson(result)
  if (result.errors.length > 0) {
    throw new CliError(`Provisioning reported ${result.errors.length} error(s).`)
  }
}

export const identityProvidersCommand = verbCommand('idps', {
  ...providers,
  'mapper-status': mapperStatus,
  mappers: mappers.list,
  'mapper-types': mapperTypes,
  'fix-mappers': fixMappers,
  'create-mapper': mappers.create,
  'update-mapper': mappers.update,
  'delete-mapper': mappers.delete,
})
