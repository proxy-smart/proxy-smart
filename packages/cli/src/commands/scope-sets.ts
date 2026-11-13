// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** `proxy-smart scope-sets <verb>`: reusable SMART scope sets. */
import { CreateScopeSetRequestFromJSON } from '../api-client'
import { dataVerb, jsonVerb, listVerb, noTarget, positional, verb, verbCommand } from './verbs/core'

const scopeSetId = positional('id')

export const scopeSetsCommand = verbCommand('scope-sets', {
  list: verb(listVerb({
    fetch: ({ api }) => api.scopeSets.getAdminScopeSets(),
    rows: response => response.scopeSets,
  })),
  get: verb(jsonVerb(scopeSetId, (api, id) => api.scopeSets.getAdminScopeSetsById({ id })), '<id>'),
  create: verb(dataVerb(noTarget, (api, data) => api.scopeSets.postAdminScopeSets({
    createScopeSetRequest: CreateScopeSetRequestFromJSON(data),
  }))),
  delete: verb(jsonVerb(scopeSetId, (api, id) => api.scopeSets.deleteAdminScopeSetsById({ id })), '<id>'),
})
