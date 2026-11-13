// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * `proxy-smart smart-scopes <verb>`: the Keycloak client scopes behind SMART authorization.
 * A requested scope missing here fails the whole request with `invalid_scope`.
 */
import {
  CreateSmartScopeRequestFromJSON,
  CreateSmartScopeBatchRequestFromJSON,
} from '../api-client'
import { flagBool } from '../args'
import { dataVerb, jsonVerb, listVerb, noTarget, positional, verb, verbCommand } from './verbs/core'

export const smartScopesCommand = verbCommand('smart-scopes', {
  list: verb(listVerb({
    fetch: ({ api, args }) => api.admin.getAdminSmartScopes({
      smartOnly: flagBool(args.flags, 'smart-only') ? 'true' : undefined,
    }),
    rows: response => response.scopes,
  }), '[--smart-only]'),
  create: verb(dataVerb(noTarget, (api, data) => api.admin.postAdminSmartScopes({
    createSmartScopeRequest: CreateSmartScopeRequestFromJSON(data),
  }))),
  batch: verb(dataVerb(noTarget, (api, data) => api.admin.postAdminSmartScopesBatch({
    createSmartScopeBatchRequest: CreateSmartScopeBatchRequestFromJSON(data),
  }))),
  delete: verb(jsonVerb(positional('scopeId'), (api, scopeId) => api.admin.deleteAdminSmartScopesByScopeId({ scopeId })), '<scopeId>'),
})
