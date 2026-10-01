/**
 * `proxy-smart smart-scopes <verb>`: the Keycloak client scopes behind SMART authorization.
 * A requested scope missing here fails the whole request with `invalid_scope`.
 */
import {
  CreateSmartScopeRequestFromJSON,
  CreateSmartScopeBatchRequestFromJSON,
} from '../api-client'
import { flagBool } from '../args'
import { dataVerb, jsonVerb, listVerb, noTarget, positional, verbCommand } from './verbs/core'

export const smartScopesCommand = verbCommand('smart-scopes', {
  list: listVerb({
    fetch: ({ api, args }) => api.admin.getAdminSmartScopes({
      smartOnly: flagBool(args.flags, 'smart-only') ? 'true' : undefined,
    }),
    rows: response => response.scopes,
  }),
  create: dataVerb(noTarget, (api, data) => api.admin.postAdminSmartScopes({
    createSmartScopeRequest: CreateSmartScopeRequestFromJSON(data),
  })),
  batch: dataVerb(noTarget, (api, data) => api.admin.postAdminSmartScopesBatch({
    createSmartScopeBatchRequest: CreateSmartScopeBatchRequestFromJSON(data),
  })),
  delete: jsonVerb(positional('scopeId'), (api, scopeId) => api.admin.deleteAdminSmartScopesByScopeId({ scopeId })),
})
