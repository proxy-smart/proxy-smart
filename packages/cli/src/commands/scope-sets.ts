/** `proxy-smart scope-sets <verb>`: reusable SMART scope sets. */
import { CreateScopeSetRequestFromJSON } from '../api-client'
import { dataVerb, jsonVerb, listVerb, noTarget, positional, verbCommand } from './verbs/core'

const scopeSetId = positional('id')

export const scopeSetsCommand = verbCommand('scope-sets', {
  list: listVerb({
    fetch: ({ api }) => api.scopeSets.getAdminScopeSets(),
    rows: response => response.scopeSets,
  }),
  get: jsonVerb(scopeSetId, (api, id) => api.scopeSets.getAdminScopeSetsById({ id })),
  create: dataVerb(noTarget, (api, data) => api.scopeSets.postAdminScopeSets({
    createScopeSetRequest: CreateScopeSetRequestFromJSON(data),
  })),
  delete: jsonVerb(scopeSetId, (api, id) => api.scopeSets.deleteAdminScopeSetsById({ id })),
})
